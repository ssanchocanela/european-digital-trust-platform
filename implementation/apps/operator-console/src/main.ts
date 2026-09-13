import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  archiveHashPid,
  beginLogin,
  checkEntity,
  completeLogin,
  DEFAULT_BASE_URL,
  type EntityCheck,
  hashPidFingerprint,
  issueAccessCertificate,
  issueRegistrationCertificate,
  openStore,
  pollLogin,
  previousHashPidFingerprint,
  readState,
  runChain,
  stabilityVerdict,
  stepStatuses,
} from "@edtp/registration-client";
import { mintStartToken } from "@edtp/start-token";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { loadConfig } from "./config.js";
import type { SafeHtml } from "./html.js";
import { type Interaction, InteractionCache } from "./interaction-cache.js";
import {
  issuanceOffersView,
  issuancePolicyView,
  issuedCredentialsView,
} from "./issuance-views.js";
import { CONSOLE_CSS, CONTENT_SECURITY_POLICY, notice, page } from "./layout.js";
import { Logger } from "./logger.js";
import { newOfferView, offersView, offerView } from "./offer-views.js";
import type { CreatedPresentation, ProviderAuthentication } from "./platform-client.js";
import { PlatformApiError, PlatformClient } from "./platform-client.js";
import { renderQrWithValue } from "./qr.js";
import { checkInteractionReachability } from "./reachability.js";
import {
  REGISTRATION_JS,
  registrationLoginView,
  registrationView,
} from "./registration-views.js";
import { auditView, servicesView, tenantView } from "./registry-views.js";
import { clearSession, hasValidSession, isCorrectPassword, issueSession } from "./session.js";
import {
  CONSOLE_JS,
  healthView,
  loginView,
  presentationView,
  type RunContext,
  statusPayload,
  testDriverView,
} from "./views.js";

/**
 * The operator console.
 *
 * Plain Express and server-rendered HTML. Not Nest: this is six routes that return markup, and
 * `CLAUDE.md` §3.7 says not to over-engineer V0. Not a single-page application either — see
 * `docs/web-interface-proposal.md` §4 for why, the short version being that the tenant API key must
 * never reach the browser and the screens are forms and tables.
 *
 * **Management surface.** It binds to `127.0.0.1` and is never added to the gateway allow-list
 * (`docs/test-session-gateway.md` §1c). The only publicly reachable part of this workstream is
 * `apps/test-start`, which holds no credential and can only redirect.
 */

/**
 * Defining an offer.
 *
 * `credential` and every `claim` carry the intended use and the index of the registered credential
 * they came from, so the server can re-derive both from the registration instead of trusting a form
 * that a browser can edit. A claim whose prefix does not match the chosen credential is dropped
 * rather than attached to it.
 */
const defineOfferForm = z
  .object({
    serviceId: z.string().uuid(),
    credential: z.string().min(3).max(200),
    // A single checkbox arrives as a string, several as an array, none as undefined. All three are
    // the same thing to this form.
    claim: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
    name: z.string().min(1).max(200),
    purpose: z.string().min(1).max(300),
    resultKind: z.enum(["VERIFIED_CLAIMS", "AGE_OVER_18"]),
  })
  .strict();

/** The message a caller should see, never a stack and never an engine's diagnostic detail. */
const messageOf = (error: unknown): string =>
  error instanceof PlatformApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : "The platform could not be reached.";

const createPresentationForm = z
  .object({
    policyId: z.string().uuid(),
    // An empty field arrives as "" from a browser, which must mean "latest published version" rather
    // than a validation error — that is the common case, so it cannot be the awkward one.
    policyVersion: z
      .string()
      .optional()
      .transform((v) => (v === undefined || v.trim() === "" ? undefined : Number(v)))
      .refine((v) => v === undefined || (Number.isInteger(v) && v >= 1), {
        message: "policyVersion must be a positive integer",
      }),
    businessReference: z.string().min(1).max(200),
    interactionType: z.enum(["SAME_DEVICE", "QR"]),
  })
  .strict();

const main = async (): Promise<void> => {
  const config = loadConfig();
  const logger = new Logger(config.LOG_LEVEL);
  const platform = new PlatformClient(
    config.PLATFORM_API_BASE_URL,
    config.CONSOLE_TENANT_API_KEY,
    config.PLATFORM_API_TIMEOUT_MS,
  );

  // The interaction URI is returned by `POST` and not by `GET`, so it is held here for the few minutes
  // between creating a presentation and rendering its page. See `interaction-cache.ts` for why this is
  // the least-bad of three options, and for the correction it implies to the proposal.
  const interactions = new InteractionCache();

  const run: RunContext = {
    // Informational, for the run record. Absent rather than guessed when it is not supplied.
    platformCommit: process.env["PLATFORM_COMMIT"] ?? "<unset: set PLATFORM_COMMIT>",
    engineDigest: process.env["ENGINE_IMAGE_DIGEST"] ?? "<unset: set ENGINE_IMAGE_DIGEST>",
    // V0 supports TEST only (`CLAUDE.md` §7). Hard-coded rather than configurable: a console that could
    // be told it was in production would eventually say so on a screenshot.
    trustEnvironment: "TEST",
  };

  const app = express();
  app.disable("x-powered-by");
  // The console never parses JSON bodies: every mutation is a same-origin form post, which together
  // with `SameSite=Strict` is what stands in for CSRF tokens.
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));

  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    // A management console has nothing a search engine or an intermediary cache should keep.
    response.setHeader("cache-control", "no-store");
    next();
  });

  const render = (
    response: Response,
    title: string,
    body: SafeHtml,
    authenticated: boolean,
  ): void => {
    response
      .status(response.statusCode)
      .type("html")
      .send(
        page({
          title,
          body,
          authenticated,
          trustEnvironment: run.trustEnvironment,
          // A hint, not the key: enough for an operator to tell two consoles apart, useless to anyone
          // who sees a screenshot. Never the key itself, and never more of it than this.
          tenantHint: `…${config.CONSOLE_TENANT_API_KEY.slice(-4)}`,
        }),
      );
  };

  // --- assets ---------------------------------------------------------------------------------
  //
  // Served from memory rather than disk: there is no static directory, so there is no path traversal
  // and nothing to misconfigure. Two files, both ours.
  app.get("/assets/console.css", (_request, response) => {
    response.type("css").send(CONSOLE_CSS);
  });
  app.get("/assets/console.js", (_request, response) => {
    response.type("js").send(CONSOLE_JS);
  });

  // --- session --------------------------------------------------------------------------------

  const nowSeconds = (): number => Math.floor(Date.now() / 1_000);
  const secureCookie =
    config.NODE_ENV === "production" && config.CONSOLE_BIND_HOST !== "127.0.0.1";

  app.get("/login", (request, response) => {
    if (
      hasValidSession(request, {
        secret: config.CONSOLE_SESSION_SECRET,
        nowSeconds: nowSeconds(),
      })
    ) {
      response.redirect(303, "/");
      return;
    }
    render(response, "Sign in", loginView(), false);
  });

  app.post("/login", (request, response) => {
    const provided = typeof request.body?.password === "string" ? request.body.password : "";
    if (!isCorrectPassword(config.CONSOLE_OPERATOR_PASSWORD, provided)) {
      // Logged without the attempt, and at `warn`: on a localhost-bound console a failed login is worth
      // noticing, because the expected number is zero.
      logger.warn("operator login failed");
      response.status(401);
      render(response, "Sign in", loginView("Incorrect password."), false);
      return;
    }
    issueSession(response, {
      secret: config.CONSOLE_SESSION_SECRET,
      ttlSeconds: config.CONSOLE_SESSION_TTL_SECONDS,
      nowSeconds: nowSeconds(),
      secureCookie,
    });
    logger.info("operator signed in");
    response.redirect(303, "/");
  });

  app.post("/logout", (_request, response) => {
    clearSession(response);
    response.redirect(303, "/login");
  });

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (
      hasValidSession(request, {
        secret: config.CONSOLE_SESSION_SECRET,
        nowSeconds: nowSeconds(),
      })
    ) {
      next();
      return;
    }
    if (request.method === "GET") {
      response.redirect(303, "/login");
      return;
    }
    response.status(401).type("text").send("Not signed in.");
  });

  // --- the registry: what this tenant is ---------------------------------------------------------

  app.get("/services", async (_request, response) => {
    try {
      const services = await platform.listServices();
      const detailed = await Promise.all(
        services.map(async (service) => ({
          ...service,
          intendedUses: await platform.listIntendedUses(service.id).catch(() => []),
          instance: await platform.readInstance(service.id),
        })),
      );
      render(response, "Relying Party Services", servicesView({ services: detailed }), true);
    } catch (error) {
      response.status(502);
      render(
        response,
        "Relying Party Services",
        servicesView({ services: [], error: messageOf(error) }),
        true,
      );
    }
  });

  app.get("/presentations/:presentationId/audit", async (request, response) => {
    const id = request.params.presentationId ?? "";
    try {
      const events = await platform.listAudit(id);
      render(response, "Audit trail", auditView({ presentationId: id, events }), true);
    } catch (error) {
      response.status(502);
      render(
        response,
        "Audit trail",
        auditView({ presentationId: id, events: [], error: messageOf(error) }),
        true,
      );
    }
  });

  app.get("/tenant", async (_request, response) => {
    try {
      // Counted from the same list routes every other screen uses. The console has no privileged
      // view, so these are the numbers its own credential can see and no others.
      const [me, services, offers, issuance, providers, gate, health] = await Promise.all([
        platform.whoAmI(),
        platform.listServices(),
        platform.listPresentationPolicies(),
        platform.listIssuancePolicies(),
        platform.listAttestationProviders(),
        readGate(),
        platform.health(),
      ]);
      render(
        response,
        "This tenant",
        tenantView({
          tenantId: me.tenantId,
          services: services.length,
          presentationPolicies: offers.options.length,
          issuancePolicies: issuance.length,
          providers: providers.length,
          ...(gate ? { gate } : {}),
          platform: health.status,
          engine: health.engine,
        }),
        true,
      );
    } catch (error) {
      response.status(502);
      render(
        response,
        "This tenant",
        tenantView({
          tenantId: "—",
          services: 0,
          presentationPolicies: 0,
          issuancePolicies: 0,
          providers: 0,
          platform: "unknown",
          engine: "unknown",
          error: messageOf(error),
        }),
        true,
      );
    }
  });

  // --- issuance ----------------------------------------------------------------------------------
  //
  // The gate comes first on every screen here. ARF §6.6.2.2 requires a Wallet to authenticate the
  // Credential Issuer from signed metadata before requesting anything, the engine produces none, and
  // a wallet has been watched refusing exactly there. A console that showed offers without saying so
  // would let an operator publish one, hand out a link, and learn from a user that nothing can be
  // collected.

  /** Trust gate (a), for whichever provider this tenant has. Never fabricated. */
  const readGate = async (): Promise<ProviderAuthentication | undefined> => {
    try {
      const providers = await platform.listAttestationProviders();
      const first = providers[0];
      if (!first) {
        return {
          error: "no_attestation_provider",
          message: "This tenant has no Attestation Provider.",
        };
      }
      return await platform.providerAuthentication(first.id);
    } catch (error) {
      // A refusal from the platform is an **answer** and is passed through: it says why, and the
      // reason is usually actionable — "the provider has no engine tenant yet" is a thing an operator
      // can fix. Only a failure to reach the platform at all returns `undefined`, which the view
      // renders as "could not be read" rather than as a reassuring default.
      if (error instanceof PlatformApiError) {
        logger.info("provider authentication refused", { code: error.code });
        return { error: error.code, message: error.message };
      }
      logger.warn("provider authentication unavailable", { code: "unknown" });
      return undefined;
    }
  };

  app.get("/issuance", async (_request, response) => {
    try {
      const [policies, issuances, gate] = await Promise.all([
        platform.listIssuancePolicies(),
        platform.listIssuances(),
        readGate(),
      ]);
      const counts = new Map<string, number>();
      for (const i of issuances) counts.set(i.policyId, (counts.get(i.policyId) ?? 0) + 1);
      render(
        response,
        "Issuance",
        issuanceOffersView({
          policies: policies.map((p) => ({ ...p, issuances: counts.get(p.id) ?? 0 })),
          ...(gate ? { gate } : {}),
        }),
        true,
      );
    } catch (error) {
      response.status(502);
      render(
        response,
        "Issuance",
        issuanceOffersView({ policies: [], error: messageOf(error) }),
        true,
      );
    }
  });

  app.get("/issuance/credentials", async (_request, response) => {
    try {
      const credentials = await platform.listIssuedCredentials();
      render(response, "Issued attestations", issuedCredentialsView({ credentials }), true);
    } catch (error) {
      response.status(502);
      render(
        response,
        "Issued attestations",
        issuedCredentialsView({ credentials: [], error: messageOf(error) }),
        true,
      );
    }
  });

  app.post("/issuance/credentials/:id/status", async (request, response) => {
    const id = request.params.id ?? "";
    const wanted = request.body?.status;
    const status =
      wanted === "REVOKED" || wanted === "SUSPENDED" || wanted === "VALID" ? wanted : undefined;
    let notice: string | undefined;
    let error: string | undefined;
    if (!status) {
      error = "That is not a status this console can set.";
    } else {
      try {
        await platform.changeCredentialStatus(id, status);
        // The identifier, never the status-list index: the index is an `ISSU_35` unique element.
        logger.info("attestation status changed", { issuedCredentialId: id, status });
        notice =
          status === "REVOKED"
            ? "Revoked. That cannot be undone."
            : status === "SUSPENDED"
              ? "Suspended. It can be reinstated."
              : "Reinstated.";
      } catch (e) {
        error = messageOf(e);
      }
    }
    const credentials = await platform.listIssuedCredentials().catch(() => []);
    if (error) response.status(400);
    render(
      response,
      "Issued attestations",
      issuedCredentialsView({
        credentials,
        ...(notice ? { notice } : {}),
        ...(error ? { error } : {}),
      }),
      true,
    );
  });

  /** One issuance policy, with whatever offer is currently open for it. */
  const renderIssuancePolicy = async (
    response: Response,
    policyId: string,
    extra: {
      readonly offer?: { uri: string; issuanceId: string; expiresAt: string };
      readonly error?: string;
    } = {},
  ): Promise<void> => {
    const [policies, issuances, gate] = await Promise.all([
      platform.listIssuancePolicies(),
      platform.listIssuances(policyId),
      readGate(),
    ]);
    const policy = policies.find((p) => p.id === policyId);
    if (!policy) {
      response.status(404);
      render(
        response,
        "Issuance",
        issuanceOffersView({ policies: [], error: "No such issuance policy." }),
        true,
      );
      return;
    }
    render(
      response,
      policy.name,
      issuancePolicyView({
        policy,
        issuances,
        ...(gate ? { gate } : {}),
        ...(extra.offer ? { offer: extra.offer } : {}),
        ...(extra.offer
          ? {
              qr: renderQrWithValue(extra.offer.uri, "Credential offer — scan with the wallet"),
            }
          : {}),
        ...(extra.error ? { error: extra.error } : {}),
      }),
      true,
    );
  };

  app.get("/issuance/:policyId", async (request, response) => {
    try {
      await renderIssuancePolicy(response, request.params.policyId ?? "");
    } catch (error) {
      response.status(502);
      render(
        response,
        "Issuance",
        issuanceOffersView({ policies: [], error: messageOf(error) }),
        true,
      );
    }
  });

  app.post("/issuance/:policyId/offer", async (request, response) => {
    const policyId = request.params.policyId ?? "";
    const subjectReference =
      typeof request.body?.subjectReference === "string"
        ? request.body.subjectReference.trim()
        : "";
    if (!subjectReference) {
      response.status(400);
      await renderIssuancePolicy(response, policyId, {
        error:
          "A subject reference is needed: it is how the authentic source is asked who this is.",
      });
      return;
    }
    try {
      const created = await platform.createIssuance({
        policyId,
        subjectReference,
        businessReference: `console-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "")}`,
      });
      logger.info("credential offer created", {
        issuanceId: created.issuanceId,
        policyId,
        status: created.status,
      });
      await renderIssuancePolicy(response, policyId, {
        ...(created.offer
          ? {
              offer: {
                uri: created.offer.uri,
                issuanceId: created.issuanceId,
                expiresAt: created.expiresAt,
              },
            }
          : {}),
      });
    } catch (error) {
      response.status(502);
      await renderIssuancePolicy(response, policyId, { error: messageOf(error) });
    }
  });

  // --- verification offers --------------------------------------------------------------------
  //
  // The three things an operator does with an offer: see what is published, define a new one, and
  // work one — get an invitation out and watch what comes back. Named "offer" on screen and
  // `PresentationPolicy` in the API, because the operator is publishing something a holder can be
  // asked to satisfy, and that is the word for it.

  /** Offers with a presentation count each, which is the only number the list view needs. */
  const offersWithCounts = async () => {
    const [{ options: policies }, presentations] = await Promise.all([
      platform.listPresentationPolicies(),
      platform.listPresentations(),
    ]);
    const counts = new Map<string, number>();
    for (const p of presentations) {
      counts.set(p.policyId, (counts.get(p.policyId) ?? 0) + 1);
    }
    return policies.map((p) => ({ ...p, presentations: counts.get(p.id) ?? 0 }));
  };

  app.get("/offers", async (_request, response) => {
    try {
      const [offers, services] = await Promise.all([
        offersWithCounts(),
        platform.listServices(),
      ]);
      render(response, "Verification offers", offersView({ offers, services }), true);
    } catch (error) {
      response.status(502);
      render(
        response,
        "Verification offers",
        offersView({ offers: [], services: [], error: messageOf(error) }),
        true,
      );
    }
  });

  app.get("/offers/new", async (request, response) => {
    const serviceId =
      typeof request.query.serviceId === "string" ? request.query.serviceId : "";
    try {
      const services = await platform.listServices();
      // Only after a Service is chosen: an intended use belongs to one, and asking for all of them
      // would offer claims registered by a party this offer is not operated under.
      const intendedUses = serviceId ? await platform.listIntendedUses(serviceId) : [];
      render(
        response,
        "Define an offer",
        newOfferView({
          services,
          intendedUses,
          ...(serviceId ? { selectedServiceId: serviceId } : {}),
        }),
        true,
      );
    } catch (error) {
      response.status(502);
      render(
        response,
        "Define an offer",
        newOfferView({ services: [], intendedUses: [], error: messageOf(error) }),
        true,
      );
    }
  });

  app.post("/offers", async (request, response) => {
    const parsed = defineOfferForm.safeParse(request.body);
    if (!parsed.success) {
      response.status(400);
      const services = await platform.listServices().catch(() => []);
      render(
        response,
        "Define an offer",
        newOfferView({
          services,
          intendedUses: [],
          error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        }),
        true,
      );
      return;
    }
    const form = parsed.data;

    try {
      // `credential` and each `claim` carry the intended use and the index of the registered
      // credential they came from, so a claim cannot be attached to a credential it was not
      // registered under by editing the form.
      const [intendedUseId, credentialIndexRaw] = form.credential.split("|");
      if (!intendedUseId || credentialIndexRaw === undefined) {
        throw new Error("Choose a credential to ask for.");
      }
      const credentialIndex = Number(credentialIndexRaw);
      const uses = await platform.listIntendedUses(form.serviceId);
      const use = uses.find((u) => u.id === intendedUseId);
      const credential = use?.registeredCredentials[credentialIndex];
      if (!use || !credential) {
        throw new Error("That credential is not registered under the chosen Service.");
      }

      const prefix = `${intendedUseId}|${credentialIndexRaw}|`;
      const claims = form.claim
        .filter((c) => c.startsWith(prefix))
        .map((c) => JSON.parse(c.slice(prefix.length)) as (string | number | null)[]);
      if (claims.length === 0) {
        throw new Error("Choose at least one attribute to ask for.");
      }

      const credentialType =
        credential.vctValues?.[0] ?? credential.doctype ?? credential.format;
      const resultPolicy =
        form.resultKind === "AGE_OVER_18"
          ? {
              kind: "DERIVED_CLAIMS",
              derivations: [
                {
                  name: "AgeAtLeast",
                  // The claim the holder discloses, which the derivation consumes and discards.
                  sourcePath: claims[0],
                  minimumAgeYears: 18,
                  outputClaim: "over_18",
                },
              ],
            }
          : { kind: "VERIFIED_CLAIMS", allowedClaims: claims };

      const { policyId } = await platform.createOffer({
        relyingPartyServiceId: form.serviceId,
        intendedUseId,
        name: form.name,
        description: form.purpose,
        purpose: form.purpose,
        credentialType,
        acceptedFormats: [credential.format],
        requestedClaims: claims,
        resultPolicy,
      });
      logger.info("offer defined", { policyId });
      response.redirect(303, `/offers/${encodeURIComponent(policyId)}`);
    } catch (error) {
      response.status(400);
      const services = await platform.listServices().catch(() => []);
      const intendedUses = await platform.listIntendedUses(form.serviceId).catch(() => []);
      render(
        response,
        "Define an offer",
        newOfferView({
          services,
          intendedUses,
          selectedServiceId: form.serviceId,
          error: messageOf(error),
        }),
        true,
      );
    }
  });

  /** One offer, with whatever invitation is currently open for it. */
  const renderOffer = async (
    response: Response,
    policyId: string,
    extra: { readonly created?: CreatedPresentation; readonly error?: string } = {},
  ): Promise<void> => {
    const [{ options: policies }, presentations] = await Promise.all([
      platform.listPresentationPolicies(),
      platform.listPresentations(policyId),
    ]);
    const offer = policies.find((p) => p.id === policyId);
    if (!offer) {
      response.status(404);
      render(
        response,
        "Offer",
        offersView({ offers: [], services: [], error: "No such offer." }),
        true,
      );
      return;
    }

    let invite: { uri: string; type: string } | undefined;
    let qr: SafeHtml | undefined;
    let startUrl: string | undefined;
    if (extra.created?.interaction) {
      const interaction = extra.created.interaction;
      if (interaction.type === "SAME_DEVICE" && config.TEST_START_PUBLIC_URL) {
        const token = mintStartToken(config.START_TOKEN_SECRET, {
          uri: interaction.uri,
          presentationId: extra.created.presentationId,
          nowSeconds: nowSeconds(),
        });
        startUrl = new URL(`/s/${token}`, config.TEST_START_PUBLIC_URL).toString();
        qr = renderQrWithValue(
          startUrl,
          "Same-device — scan to open the start page on the phone",
        );
      } else {
        qr = renderQrWithValue(interaction.uri, "Cross-device (QR) — the OpenID4VP request");
      }
      invite = { uri: interaction.uri, type: interaction.type };
    }

    render(
      response,
      offer.name,
      offerView({
        offer,
        presentations,
        sameDeviceAvailable: config.TEST_START_PUBLIC_URL !== undefined,
        ...(invite ? { interaction: invite } : {}),
        ...(qr ? { qr } : {}),
        ...(startUrl ? { startUrl } : {}),
        ...(extra.created ? { expiresAt: extra.created.expiresAt } : {}),
        ...(extra.error ? { error: extra.error } : {}),
      }),
      true,
    );
  };

  app.get("/offers/:policyId", async (request, response) => {
    try {
      await renderOffer(response, request.params.policyId ?? "");
    } catch (error) {
      response.status(502);
      render(
        response,
        "Offer",
        offersView({ offers: [], services: [], error: messageOf(error) }),
        true,
      );
    }
  });

  app.post("/offers/:policyId/present", async (request, response) => {
    const policyId = request.params.policyId ?? "";
    const interactionType =
      request.body?.interactionType === "SAME_DEVICE" ? "SAME_DEVICE" : "QR";
    try {
      const created = await platform.createPresentation({
        policyId,
        businessReference: `console-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "")}`,
        interactionType,
      });
      if (created.interaction) {
        interactions.set(created.presentationId, created.interaction);
      }
      // The URI itself is never logged: it is a live capability to start a wallet interaction.
      logger.info("invitation created", {
        presentationId: created.presentationId,
        policyId,
        interactionType,
      });
      await renderOffer(response, policyId, { created });
    } catch (error) {
      response.status(502);
      await renderOffer(response, policyId, { error: messageOf(error) }).catch(() => {
        render(
          response,
          "Offer",
          offersView({ offers: [], services: [], error: messageOf(error) }),
          true,
        );
      });
    }
  });

  // --- test driver ----------------------------------------------------------------------------

  /**
   * The test driver's options, including the policy list.
   *
   * **Never throws.** The picker is one extra call to the platform, and a screen that cannot start a
   * presentation because a list call failed would be worse than the screen that had no list at all.
   * A failure degrades to the text box, and says so on the page rather than in a log nobody reads.
   */
  const driverOptions = async (extra?: {
    readonly error?: string;
    readonly defaultPolicyId?: string;
    readonly sameDeviceAvailable?: boolean;
  }) => {
    const base = {
      sameDeviceAvailable:
        extra?.sameDeviceAvailable ?? config.TEST_START_PUBLIC_URL !== undefined,
      ...(extra?.error ? { error: extra.error } : {}),
      ...(extra?.defaultPolicyId ? { defaultPolicyId: extra.defaultPolicyId } : {}),
    };
    try {
      const { options, truncated } = await platform.listPresentationPolicies();
      return { ...base, policies: options, policiesTruncated: truncated };
    } catch (error) {
      logger.warn("policy list unavailable, falling back to typed id", {
        code: error instanceof PlatformApiError ? error.code : "unknown",
      });
      return {
        ...base,
        policiesError:
          error instanceof PlatformApiError ? error.code : "the platform could not be reached",
      };
    }
  };

  app.get("/", async (_request, response) => {
    render(response, "Test driver", testDriverView(await driverOptions()), true);
  });

  app.post("/presentations", async (request, response) => {
    const parsed = createPresentationForm.safeParse(request.body);
    if (!parsed.success) {
      response.status(400);
      render(
        response,
        "Test driver",
        testDriverView(
          await driverOptions({
            error: parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; "),
          }),
        ),
        true,
      );
      return;
    }
    const form = parsed.data;

    if (form.interactionType === "SAME_DEVICE" && config.TEST_START_PUBLIC_URL === undefined) {
      response.status(400);
      render(
        response,
        "Test driver",
        testDriverView(
          await driverOptions({
            sameDeviceAvailable: false,
            defaultPolicyId: form.policyId,
            error:
              "Same-device needs TEST_START_PUBLIC_URL, because the phone has to open a publicly " +
              "reachable page. Use QR, or configure the start page.",
          }),
        ),
        true,
      );
      return;
    }

    try {
      const created = await platform.createPresentation({
        policyId: form.policyId,
        ...(form.policyVersion !== undefined ? { policyVersion: form.policyVersion } : {}),
        businessReference: form.businessReference,
        interactionType: form.interactionType,
      });
      // Nothing about the transaction is stored here. The redirect carries the id in a path segment,
      // and the next request reads it back from the API — so the console holds no state of its own.
      if (created.interaction) {
        interactions.set(created.presentationId, created.interaction);
      }
      // The URI itself is never logged: it is a live capability to start a wallet interaction.
      logger.info("presentation created", {
        presentationId: created.presentationId,
        interactionType: form.interactionType,
        interactionUriReturned: created.interaction !== undefined,
      });
      response.redirect(303, `/presentations/${encodeURIComponent(created.presentationId)}`);
    } catch (error) {
      const message =
        error instanceof PlatformApiError
          ? error.message
          : "The presentation could not be created.";
      logger.error("presentation creation failed", {
        code: error instanceof PlatformApiError ? error.code : "unknown",
      });
      response.status(502);
      render(
        response,
        "Test driver",
        // The chosen policy is carried back, so a failure that is nothing to do with the choice
        // does not make someone find it again.
        testDriverView(await driverOptions({ defaultPolicyId: form.policyId, error: message })),
        true,
      );
    }
  });

  app.get("/presentations/:presentationId", async (request, response) => {
    const id = request.params.presentationId ?? "";
    try {
      const view = await platform.readPresentation(id);
      renderPresentation(response, view, interactions.get(id));
    } catch (error) {
      const message =
        error instanceof PlatformApiError
          ? error.message
          : "That presentation could not be read.";
      response.status(error instanceof PlatformApiError ? error.status : 502);
      render(response, "Presentation", notice("error", message), true);
    }
  });

  /**
   * The poller's endpoint.
   *
   * Returns what `GET /v1/presentations/{id}` returned, plus the server-rendered result markup. It adds
   * nothing the API did not give, which is the rule the whole console follows.
   */
  app.get("/presentations/:presentationId/status.json", async (request, response) => {
    try {
      const view = await platform.readPresentation(request.params.presentationId ?? "");
      response.json(statusPayload(view));
    } catch (error) {
      response
        .status(error instanceof PlatformApiError ? error.status : 502)
        .json({ error: "unavailable" });
    }
  });

  const renderPresentation = (
    response: Response,
    view: Awaited<ReturnType<PlatformClient["readPresentation"]>>,
    interaction: Interaction | undefined,
  ): void => {
    let qrValue: string | undefined;
    let qrLabel: string | undefined;
    let startUrl: string | undefined;

    if (interaction) {
      if (interaction.type === "SAME_DEVICE" && config.TEST_START_PUBLIC_URL) {
        // Same-device: the QR carries *our* HTTPS start page, so the phone opens the wallet locally.
        // The presentation itself is same-device; the QR is only how the link reaches the phone.
        const token = mintStartToken(config.START_TOKEN_SECRET, {
          uri: interaction.uri,
          presentationId: view.presentationId,
          nowSeconds: nowSeconds(),
        });
        startUrl = new URL(`/s/${token}`, config.TEST_START_PUBLIC_URL).toString();
        qrValue = startUrl;
        qrLabel = "Same-device — scan to open the start page on the phone";
      } else {
        // Cross-device: the QR carries the OpenID4VP request itself, which is the flow ADR 0009 covers
        // and which is never presented as the demonstrated path.
        qrValue = interaction.uri;
        qrLabel = "Cross-device (QR) — the OpenID4VP request";
      }
    }

    // Checked here, where both the start URL and the URI the engine actually emitted are in hand.
    const reachability = checkInteractionReachability({
      ...(interaction ? { interactionUri: interaction.uri } : {}),
      ...(startUrl ? { startUrl } : {}),
      platformPublicUrl: config.PLATFORM_PUBLIC_URL,
    });

    render(
      response,
      "Presentation",
      presentationView({
        created: {
          presentationId: view.presentationId,
          status: view.status,
          expiresAt: view.expiresAt,
          ...(interaction ? { interaction } : {}),
          ...(view.warnings ? { warnings: view.warnings } : {}),
        },
        view,
        ...(qrValue ? { qrValue } : {}),
        ...(qrLabel ? { qrLabel } : {}),
        ...(startUrl ? { startUrl } : {}),
        reachability,
        run,
      }),
      true,
    );
  };

  // --- registration session -------------------------------------------------------------------
  // Enrolment at the reference RP Registration Service: a third-party service, not the platform.
  // It lives here because the console is already localhost-bound, refuses to bind elsewhere and is
  // absent from the gateway allow-list — the posture a flow holding `hash_pid` and minting a
  // private key needs. The session itself needs no public exposure: the login QR addresses the EUDI
  // verifier backend, so the phone never reaches this console.

  const registrationStore = openStore(config.EDTP_REGISTRATION_DIR);
  const entityPath =
    config.REGISTRATION_ENTITY_FILE ?? join(registrationStore.directory, "entity.json");
  const registryBaseUrl = config.REGISTRY_BASE_URL ?? DEFAULT_BASE_URL;
  const registrationOptions = { store: registrationStore, baseUrl: registryBaseUrl };

  /** Reads and validates the entity file, reporting its absence as a condition rather than a crash. */
  const loadEntity = (): { check?: EntityCheck; error?: string } => {
    try {
      return { check: checkEntity(JSON.parse(readFileSync(entityPath, "utf8")) as unknown) };
    } catch (error) {
      const reason =
        (error as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : "unreadable";
      return {
        error:
          `${entityPath} is ${reason}. Copy scripts/registration-entity.example.json there and ` +
          "fill in every CHANGE-ME.",
      };
    }
  };

  const renderRegistration = (response: Response, message?: SafeHtml, status = 200): void => {
    const { check, error } = loadEntity();
    const certificates: { label: string; path: string }[] = [];
    const accessPath = join(registrationStore.directory, "rpac.p12");
    if (existsSync(accessPath)) {
      certificates.push({ label: "Access certificate (PKCS#12)", path: accessPath });
    }
    const state = readState(registrationStore);
    const intendedUseId = state["intended_use"]?.[0];
    if (intendedUseId !== undefined) {
      const rcPath = join(
        registrationStore.directory,
        `rprc-intended-use-${intendedUseId}.jwt`,
      );
      if (existsSync(rcPath))
        certificates.push({ label: "Registration certificate", path: rcPath });
    }

    response.status(status);
    render(
      response,
      "Registration",
      registrationView({
        baseUrl: registryBaseUrl,
        entityPath,
        entityCheck: check,
        entityError: error,
        hashPidDigest: hashPidFingerprint(registrationStore),
        previousDigest: previousHashPidFingerprint(registrationStore),
        verdict: stabilityVerdict(registrationStore),
        steps: stepStatuses(state),
        certificates,
        message,
      }),
      true,
    );
  };

  app.get("/assets/registration.js", (_request, response) => {
    response.type("js").send(REGISTRATION_JS);
  });

  app.get("/registration", (_request, response) => {
    renderRegistration(response);
  });

  app.post("/registration/login", async (request, response) => {
    // A second login archives the first rather than overwriting it, which is what makes the
    // stability check a comparison instead of a claim.
    const reauthenticate = request.query["reauthenticate"] === "1";
    if (reauthenticate) archiveHashPid(registrationStore);

    try {
      const challenge = await beginLogin(registrationOptions);
      render(
        response,
        "Registration login",
        registrationLoginView({
          qrValue: challenge.qrValue,
          presentationId: challenge.presentationId,
          reauthenticate,
        }),
        true,
      );
    } catch (error) {
      logger.warn("registration login could not be started", {
        reason: (error as Error).message,
      });
      renderRegistration(response, notice("error", (error as Error).message), 502);
    }
  });

  app.get("/registration/login/:presentationId/status.json", async (request, response) => {
    const presentationId = request.params.presentationId;
    try {
      const presented = await pollLogin(presentationId, registrationOptions);
      response.json({ presented });
    } catch (error) {
      logger.warn("registration login poll failed", { reason: (error as Error).message });
      response.status(502).json({ presented: false });
    }
  });

  app.post("/registration/login/complete", async (request, response) => {
    const presentationId = String(
      (request.body as Record<string, unknown>)["presentationId"] ?? "",
    );
    if (presentationId.length === 0) {
      renderRegistration(response, notice("error", "No presentation to complete."), 400);
      return;
    }
    try {
      // Stores the credential, mode 600, and does not return it: every consumer needs it only
      // inside a request body, and a return value is one more place it could reach a log.
      await completeLogin(presentationId, registrationOptions);
      renderRegistration(
        response,
        notice(
          "info",
          "Authenticated. Only the digest of the session credential is ever shown.",
        ),
      );
    } catch (error) {
      renderRegistration(response, notice("error", (error as Error).message), 502);
    }
  });

  app.post("/registration/run", async (_request, response) => {
    const { check } = loadEntity();
    if (!check?.entity || !check.runnable) {
      renderRegistration(response, notice("error", "Fix the entity file first."), 400);
      return;
    }
    try {
      const outcomes = await runChain(check.entity, registrationOptions);
      const created = outcomes.filter((outcome) => !outcome.skipped).length;
      renderRegistration(
        response,
        notice(
          "info",
          created === 0
            ? "Nothing to do: every step was already recorded."
            : `Registered. ${created} of ${outcomes.length} steps ran; the rest were already done.`,
        ),
      );
    } catch (error) {
      // The chain stops where it failed and the state file keeps what succeeded, so the next run
      // resumes rather than duplicating. Saying so matters: the instinct on an error is to retry
      // from the beginning, which here would create a second set of entities.
      logger.warn("registration chain failed", { reason: (error as Error).message });
      renderRegistration(
        response,
        notice(
          "error",
          `${(error as Error).message} — the steps that succeeded are recorded, so running again ` +
            "resumes from here rather than starting over.",
        ),
        502,
      );
    }
  });

  app.post("/registration/certificate", async (request, response) => {
    const passphrase = String((request.body as Record<string, unknown>)["passphrase"] ?? "");
    if (passphrase.length < 12) {
      renderRegistration(
        response,
        notice(
          "error",
          "The passphrase protects a private key; use at least twelve characters.",
        ),
        400,
      );
      return;
    }
    try {
      const access = await issueAccessCertificate(passphrase, registrationOptions);
      const registration = await issueRegistrationCertificate(registrationOptions);
      renderRegistration(
        response,
        notice(
          "info",
          `Access certificate written to ${access.path} and the registration certificate to ` +
            `${registration.path}, both mode 600. The registration certificate's encoding is ` +
            "unverified — documented as JAdES and COSE — so check what it actually is before " +
            "importing it. Now run the chain check: it, not this, is what closes B1.",
        ),
      );
    } catch (error) {
      renderRegistration(response, notice("error", (error as Error).message), 502);
    }
  });

  // --- health ---------------------------------------------------------------------------------

  app.get("/health", async (_request, response) => {
    try {
      const health = await platform.health();
      render(
        response,
        "Health",
        healthView({ platform: health.status, engine: health.engine, run }),
        true,
      );
    } catch {
      response.status(502);
      render(
        response,
        "Health",
        healthView({ platform: "unreachable", engine: "unknown", run }),
        true,
      );
    }
  });

  app.use((_request, response) => {
    response.status(404);
    render(response, "Not found", notice("error", "No such page."), true);
  });

  const server = app.listen(config.PORT, config.CONSOLE_BIND_HOST, () => {
    logger.info("operator console listening", {
      port: config.PORT,
      host: config.CONSOLE_BIND_HOST,
      sameDeviceAvailable: config.TEST_START_PUBLIC_URL !== undefined,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info("shutting down", { signal });
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

void main().catch((error: unknown) => {
  process.stderr.write(`operator console failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});
