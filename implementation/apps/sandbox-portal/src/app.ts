import {
  PID_VARIANT_INFO,
  WRPAC_VARIANT_INFO,
  WRPAC_VARIANTS,
  WRPRC_VARIANT_INFO,
  WRPRC_VARIANTS,
} from "@edtp/sandbox-pki";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { SandboxApi } from "./api.js";
import {
  type CertificateSummary,
  certificatePage,
  dashboard,
  type IssuanceStatusView,
  type IssuerView,
  invitationLanding,
  issuancePage,
  issuerSection,
  landing,
  message,
  OBSERVATIONS,
  organisationPage,
  page,
  parseClaimLines,
  profileForm,
  type RunReport,
  runPage,
  runsSection,
  type ServiceSummary,
  STYLE,
  servicePage,
  servicesSection,
  type VerifierView,
  verifierSection,
  waiting,
  walletPage,
  walletStep,
} from "./pages.js";
import { offeredFile, openFile, readWalletOffer } from "./wallet.js";

/**
 * The sandbox portal (specification §8.1, ADR 0015).
 *
 * It holds the portal secret and nothing else: no database, no PID, no engine credential. A person's
 * session token and a sign-in's browser binding live in `__Host-` cookies — `Secure`, `HttpOnly`,
 * `SameSite=Lax` — and are forwarded to the platform, which decides.
 *
 * Cross-site requests: every state-changing route is a POST, and a POST is refused unless the
 * browser says it came from this origin (`Origin`, or `Sec-Fetch-Site: same-origin`). With `Lax`
 * cookies, a forged cross-site form carries no session anyway; the origin check is the second lock.
 */
export interface PortalOptions {
  readonly publicUrl: string;
  readonly api: SandboxApi;
  /**
   * Refuse every request that does not carry the identity Cloudflare Access injects (ADR 0017). On
   * the sandbox VM the whole portal is behind Access; this is the second lock, as for the
   * demonstration portal's operator view.
   */
  readonly requireAccess?: boolean;
  /** Where an operator places the sandbox wallet build and its `wallet.json` (wallet.ts). */
  readonly walletDir?: string;
}

export const SESSION_COOKIE = "__Host-sbx-session";
export const BINDING_COOKIE = "__Host-sbx-bind";
const SESSION_MAX_AGE_S = 8 * 60 * 60;
const BINDING_MAX_AGE_S = 10 * 60;

const CSP =
  "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (/^[A-Za-z0-9_\-.~]+$/.test(value)) out[name] = value;
  }
  return out;
}

const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
const clearCookie = (name: string) =>
  `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

/** `<attemptId>.<purpose>.<bindingToken>` — the purpose only decides which form to show. */
interface Binding {
  readonly attemptId: string;
  readonly purpose: "sign_in" | "sign_up" | "accept_invitation";
  readonly token: string;
}

export function readBinding(raw: string | undefined): Binding | undefined {
  const match =
    /^([0-9a-f-]{36})\.(sign_in|sign_up|accept_invitation)\.([A-Za-z0-9_-]{20,200})$/.exec(
      raw ?? "",
    );
  if (!match) return undefined;
  return {
    attemptId: match[1] as string,
    purpose: match[2] as Binding["purpose"],
    token: match[3] as string,
  };
}

const interaction = z.object({
  interaction: z.enum(["SAME_DEVICE", "QR"]).default("SAME_DEVICE"),
});
const uuid = z.string().uuid();
const profile = z.object({
  displayName: z.string().max(200),
  legalName: z.string().max(200).optional(),
  tradeName: z.string().max(200).optional(),
  country: z.string().max(2).optional(),
  declaredEuid: z.string().max(100).optional(),
  isPublicSectorBody: z.literal("yes").optional(),
});

export function createApp(options: PortalOptions): express.Express {
  const origin = new URL(options.publicUrl).origin;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);

  app.use((_req, res, next) => {
    res.setHeader("content-security-policy", CSP);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    next();
  });
  if (options.requireAccess) {
    app.use((req, res, next) => {
      if (req.get("cf-access-authenticated-user-email")) return next();
      res
        .status(403)
        .type("html")
        .send(
          message("Refused", "The sandbox portal is reached through Cloudflare Access only."),
        );
    });
  }

  // 32 kB: a certification request in PEM is the largest thing a form carries.
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));

  // Second lock against cross-site form posts (the first is SameSite=Lax).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST") return next();
    const fromHere =
      req.get("origin") === origin ||
      (!req.get("origin") && req.get("sec-fetch-site") === "same-origin");
    if (!fromHere) {
      res
        .status(403)
        .type("html")
        .send(message("Refused", "This form must be sent from the sandbox portal itself."));
      return;
    }
    next();
  });

  app.get("/style.css", (_req, res) => {
    res.setHeader("cache-control", "public, max-age=3600");
    res.type("text/css").send(STYLE);
  });

  const session = (req: Request) => parseCookies(req.get("cookie"))[SESSION_COOKIE];

  // --- the sandbox wallet build (ADR 0017) ---------------------------------------------------

  app.get("/wallet", (_req, res) => {
    res.type("html").send(walletPage(readWalletOffer(options.walletDir)));
  });
  app.get("/wallet/:file", (req, res) => {
    const found = offeredFile(options.walletDir, req.params.file);
    if (!found) {
      res.status(404).type("html").send(message("Not found", "No such file is offered."));
      return;
    }
    if (found.kind === "apk") {
      res.type("application/vnd.android.package-archive");
      res.setHeader("content-disposition", `attachment; filename="${req.params.file}"`);
    } else {
      res.type("text/plain; charset=utf-8");
    }
    openFile(found.path).pipe(res);
  });

  // --- start and sign-in ---------------------------------------------------------------------

  app.get("/", async (req, res) => {
    const token = session(req);
    if (token) {
      const me = await options.api.call("GET", "me", { session: token });
      if (me.status === 200) {
        const person = me.body.person as { displayName: string };
        const memberships =
          (me.body.memberships as { organisationId: string; role: string }[]) ?? [];
        res.type("html").send(
          dashboard(
            person.displayName,
            memberships.map((m) => ({ id: m.organisationId, role: m.role })),
          ),
        );
        return;
      }
      res.setHeader("set-cookie", clearCookie(SESSION_COOKIE));
    }
    res.type("html").send(landing());
  });

  const start = async (
    res: Response,
    purpose: Binding["purpose"],
    body: unknown,
    invitationToken?: string,
  ): Promise<void> => {
    const parsed = interaction.safeParse(body);
    const interactionType = parsed.success ? parsed.data.interaction : "SAME_DEVICE";
    const result = await options.api.call("POST", "sign-in-attempts", {
      body: { purpose, interactionType, ...(invitationToken ? { invitationToken } : {}) },
    });
    if (result.status !== 201) {
      const code = String(result.body.code ?? "");
      const text = code.startsWith("invitation_")
        ? "This invitation is no longer valid. Ask an owner of the organisation for a new one."
        : "Sign-in is not available right now. Please try again later.";
      res
        .status(result.status === 404 ? 404 : 503)
        .type("html")
        .send(message("Not available", text));
      return;
    }
    const attemptId = String(result.body.attemptId);
    const bindingToken = String(result.body.bindingToken);
    res.setHeader(
      "set-cookie",
      cookie(BINDING_COOKIE, `${attemptId}.${purpose}.${bindingToken}`, BINDING_MAX_AGE_S),
    );
    res.type("html").send(walletStep(String(result.body.walletUri ?? ""), interactionType));
  };

  app.post("/sign-up/start", (req, res) => start(res, "sign_up", req.body));
  app.post("/sign-in/start", (req, res) => start(res, "sign_in", req.body));

  app.get("/invite/:token", (req, res) => {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(req.params.token)) {
      res
        .status(404)
        .type("html")
        .send(message("Not found", "This invitation link is not valid."));
      return;
    }
    res.type("html").send(invitationLanding(req.params.token));
  });
  app.post("/invite/:token/start", (req, res) => {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(req.params.token)) {
      res
        .status(404)
        .type("html")
        .send(message("Not found", "This invitation link is not valid."));
      return;
    }
    return start(res, "accept_invitation", req.body, req.params.token);
  });

  /** Both the wallet's return (same device) and the polling page (QR) land here. */
  const complete = async (req: Request, res: Response) => {
    const binding = readBinding(parseCookies(req.get("cookie"))[BINDING_COOKIE]);
    // The return URL names an attempt; only the browser holding its binding can complete it.
    const named = typeof req.query.attempt === "string" ? req.query.attempt : undefined;
    if (!binding || (named && named !== binding.attemptId)) {
      res
        .status(400)
        .type("html")
        .send(
          message(
            "Start again",
            "This sign-in was started in another browser, or has expired. Start again from this browser.",
          ),
        );
      return;
    }
    const result = await options.api.call(
      "POST",
      `sign-in-attempts/${binding.attemptId}/complete`,
      {
        body: { bindingToken: binding.token },
      },
    );
    if (result.status !== 200) {
      res.setHeader("set-cookie", clearCookie(BINDING_COOKIE));
      res
        .status(410)
        .type("html")
        .send(message("Start again", "This sign-in is no longer valid. Please start again."));
      return;
    }
    switch (result.body.outcome) {
      case "pending":
        res.type("html").send(waiting());
        return;
      case "signed_in":
        res.setHeader("set-cookie", [
          clearCookie(BINDING_COOKIE),
          cookie(SESSION_COOKIE, String(result.body.sessionToken), SESSION_MAX_AGE_S),
        ]);
        res.redirect(303, "/");
        return;
      case "needs_profile":
        res
          .type("html")
          .send(profileForm(binding.purpose === "sign_up" ? "sign_up" : "accept_invitation"));
        return;
      case "unknown_person":
        res.setHeader("set-cookie", clearCookie(BINDING_COOKIE));
        res
          .type("html")
          .send(
            message("Not signed up", "No sandbox account matches this PID. Sign up first."),
          );
        return;
      default:
        res.setHeader("set-cookie", clearCookie(BINDING_COOKIE));
        res
          .type("html")
          .send(
            message(
              "Sign-in failed",
              "Your wallet's presentation was not accepted. Please try again.",
              "failed",
            ),
          );
    }
  };
  app.get("/sign-in/return", complete);
  app.get("/sign-in/wait", complete);

  app.post("/sign-in/profile", async (req, res) => {
    const binding = readBinding(parseCookies(req.get("cookie"))[BINDING_COOKIE]);
    const parsed = profile.safeParse(req.body);
    if (!binding || !parsed.success) {
      res
        .status(400)
        .type("html")
        .send(message("Start again", "This sign-in is no longer valid. Please start again."));
      return;
    }
    const p = parsed.data;
    const body: Record<string, unknown> = {
      bindingToken: binding.token,
      displayName: p.displayName,
    };
    if (binding.purpose === "sign_up") {
      body.organisation = {
        legalName: p.legalName ?? "",
        tradeName: p.tradeName ?? "",
        country: (p.country ?? "").toUpperCase(),
        ...(p.declaredEuid ? { declaredEuid: p.declaredEuid } : {}),
        isPublicSectorBody: p.isPublicSectorBody === "yes",
      };
    }
    const result = await options.api.call(
      "POST",
      `sign-in-attempts/${binding.attemptId}/profile`,
      { body },
    );
    if (result.status === 400) {
      res
        .status(400)
        .type("html")
        .send(
          profileForm(
            binding.purpose === "sign_up" ? "sign_up" : "accept_invitation",
            "Please check the fields and try again.",
          ),
        );
      return;
    }
    if (result.status !== 201) {
      res.setHeader("set-cookie", clearCookie(BINDING_COOKIE));
      res
        .status(410)
        .type("html")
        .send(message("Start again", "This sign-in is no longer valid. Please start again."));
      return;
    }
    res.setHeader("set-cookie", [
      clearCookie(BINDING_COOKIE),
      cookie(SESSION_COOKIE, String(result.body.sessionToken), SESSION_MAX_AGE_S),
    ]);
    res.redirect(303, "/");
  });

  app.post("/sign-out", async (req, res) => {
    const token = session(req);
    if (token) await options.api.call("POST", "sign-out", { session: token });
    res.setHeader("set-cookie", clearCookie(SESSION_COOKIE));
    res.redirect(303, "/");
  });

  // --- organisations -------------------------------------------------------------------------

  const requireSession = (req: Request, res: Response): string | undefined => {
    const token = session(req);
    if (!token) {
      res.redirect(303, "/");
      return undefined;
    }
    return token;
  };

  const renderOrganisation = async (
    res: Response,
    token: string,
    id: string,
    shown?: { label: string; value: string },
  ) => {
    const org = await options.api.call("GET", `organisations/${id}`, { session: token });
    if (org.status === 401) {
      res.setHeader("set-cookie", clearCookie(SESSION_COOKIE));
      res.redirect(303, "/");
      return;
    }
    if (org.status !== 200) {
      res.status(404).type("html").send(message("Not found", "No such organisation."));
      return;
    }
    const role = String(org.body.role);
    const details = org.body.organisation as {
      localIdentifier: string;
      country: string;
      declaredEuid?: string;
    };
    const members = await options.api.call("GET", `organisations/${id}/members`, {
      session: token,
    });
    const keys =
      role === "owner"
        ? await options.api.call("GET", `organisations/${id}/api-keys`, { session: token })
        : undefined;
    // The certificate service is there only when the sandbox's PKI is configured.
    const services = await options.api.call("GET", `organisations/${id}/services`, {
      session: token,
    });
    const runs = await options.api.call("GET", `organisations/${id}/runs`, { session: token });
    const sections =
      (services.status === 200
        ? servicesSection(id, services.body as unknown as ServiceSummary[])
        : "") +
      (runs.status === 200
        ? runsSection(
            id,
            runs.body as unknown as {
              id: string;
              createdAt: string;
              interaction: string;
              observed: boolean;
            }[],
          )
        : "");
    res.type("html").send(
      organisationPage(
        {
          id,
          role,
          localIdentifier: details.localIdentifier,
          country: details.country,
          ...(details.declaredEuid ? { declaredEuid: details.declaredEuid } : {}),
          members:
            (members.body as unknown as {
              personId: string;
              displayName: string;
              role: string;
            }[]) ?? [],
          ...(keys
            ? {
                apiKeys: keys.body as unknown as {
                  id: string;
                  keyPrefix: string;
                  label: string;
                }[],
              }
            : {}),
        },
        shown,
        sections,
      ),
    );
  };

  app.get("/org/:id", async (req, res) => {
    const token = requireSession(req, res);
    if (!token) return;
    if (!uuid.safeParse(req.params.id).success) {
      res.status(404).type("html").send(message("Not found", "No such organisation."));
      return;
    }
    await renderOrganisation(res, token, req.params.id);
  });

  app.post("/org/:id/invitations", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !uuid.safeParse(req.params.id).success) return void res.status(404).end();
    const role = req.body?.role === "owner" ? "owner" : "member";
    const result = await options.api.call(
      "POST",
      `organisations/${req.params.id}/invitations`,
      {
        session: token,
        body: { role },
      },
    );
    if (result.status !== 201)
      return void res
        .status(result.status === 403 ? 403 : 404)
        .type("html")
        .send(message("Refused", "Only an owner can invite."));
    const link = new URL(
      `invite/${String(result.body.invitationToken)}`,
      `${origin}/`,
    ).toString();
    await renderOrganisation(res, token, req.params.id, {
      label: `Invitation link (${role}, valid 72 hours, single use)`,
      value: link,
    });
  });

  app.post("/org/:id/api-keys", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !uuid.safeParse(req.params.id).success) return void res.status(404).end();
    const label = typeof req.body?.label === "string" ? req.body.label : "";
    const result = await options.api.call("POST", `organisations/${req.params.id}/api-keys`, {
      session: token,
      body: { label },
    });
    if (result.status !== 201)
      return void res
        .status(400)
        .type("html")
        .send(message("Refused", "The key could not be created."));
    await renderOrganisation(res, token, req.params.id, {
      label: `API key "${label}"`,
      value: String(result.body.key),
    });
  });

  app.post("/org/:id/api-keys/:keyId/revoke", async (req, res) => {
    const token = requireSession(req, res);
    if (
      !token ||
      !uuid.safeParse(req.params.id).success ||
      !uuid.safeParse(req.params.keyId).success
    ) {
      return void res.status(404).end();
    }
    await options.api.call(
      "DELETE",
      `organisations/${req.params.id}/api-keys/${req.params.keyId}`,
      { session: token },
    );
    res.redirect(303, `/org/${req.params.id}`);
  });

  app.post("/org/:id/members/:personId/remove", async (req, res) => {
    const token = requireSession(req, res);
    if (
      !token ||
      !uuid.safeParse(req.params.id).success ||
      !uuid.safeParse(req.params.personId).success
    ) {
      return void res.status(404).end();
    }
    const result = await options.api.call(
      "DELETE",
      `organisations/${req.params.id}/members/${req.params.personId}`,
      {
        session: token,
      },
    );
    if (result.status === 409) {
      res
        .status(409)
        .type("html")
        .send(message("Refused", "The last owner cannot be removed."));
      return;
    }
    res.redirect(303, `/org/${req.params.id}`);
  });

  // --- services and certificates (S3) --------------------------------------------------------

  const wrpacVariants = WRPAC_VARIANTS.map((v) => ({ id: v, ...WRPAC_VARIANT_INFO[v] }));

  const renderService = async (
    res: Response,
    token: string,
    org: string,
    sid: string,
    error?: string,
  ) => {
    const service = await options.api.call("GET", `organisations/${org}/services/${sid}`, {
      session: token,
    });
    if (service.status !== 200) {
      res.status(404).type("html").send(message("Not found", "No such service."));
      return;
    }
    const role = String(service.body.role);
    const certificates = await options.api.call(
      "GET",
      `organisations/${org}/certificates?service=${sid}`,
      { session: token },
    );
    const wrprcVariants = WRPRC_VARIANTS.filter((v) => {
      const a = WRPRC_VARIANT_INFO[v].appliesTo;
      return a === "both" || a === role;
    }).map((v) => ({ id: v, ...WRPRC_VARIANT_INFO[v] }));
    // The hosted verifier (S4) or the hosted issuer (S5), when the platform offers it: a 404 from
    // its route means it is not configured on this deployment, and the section is left out.
    let hostedHtml: string | undefined;
    if (role === "service_provider") {
      const verifier = await options.api.call(
        "GET",
        `organisations/${org}/services/${sid}/verifier`,
        {
          session: token,
        },
      );
      if (verifier.status === 200) {
        hostedHtml = verifierSection({
          orgId: org,
          serviceId: sid,
          intendedUses:
            (service.body.intendedUses as { id: string; intendedUseIdentifier: string }[]) ??
            [],
          verifier: verifier.body as unknown as VerifierView,
          wrpacVariants,
          wrprcVariants,
        });
      }
    }
    if (role === "pid_provider") {
      const issuer = await options.api.call(
        "GET",
        `organisations/${org}/services/${sid}/issuer`,
        {
          session: token,
        },
      );
      if (issuer.status === 200) {
        hostedHtml = issuerSection({
          orgId: org,
          serviceId: sid,
          issuer: issuer.body as unknown as IssuerView,
          signingVariants: (["PID-00", "PID-01", "PID-02"] as const).map((v) => ({
            id: v,
            ...PID_VARIANT_INFO[v],
          })),
          wrprcVariants,
        });
      }
    }
    res
      .status(error ? 400 : 200)
      .type("html")
      .send(
        servicePage({
          orgId: org,
          service: service.body as unknown as Parameters<typeof servicePage>[0]["service"],
          certificates: (certificates.body as unknown as CertificateSummary[]) ?? [],
          wrpacVariants,
          wrprcVariants,
          ...(error ? { error } : {}),
          ...(hostedHtml ? { verifierHtml: hostedHtml } : {}),
        }),
      );
  };

  const ids = (...values: (string | undefined)[]) =>
    values.every((v) => uuid.safeParse(v).success);
  const apiError = (body: Record<string, unknown>) =>
    typeof body.message === "string" ? body.message.slice(0, 300) : "The request was refused.";

  app.post("/org/:id/services", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id)) return void res.status(404).end();
    const b = req.body ?? {};
    const result = await options.api.call("POST", `organisations/${req.params.id}/services`, {
      session: token,
      body: {
        role: b.role === "pid_provider" ? "pid_provider" : "service_provider",
        tradeName: String(b.tradeName ?? ""),
        description: [{ lang: "en", value: String(b.description ?? "") }],
        supportUri: String(b.supportUri ?? ""),
        privacyPolicyUri: String(b.privacyPolicyUri ?? ""),
        infoUri: String(b.infoUri ?? ""),
      },
    });
    if (result.status !== 201) {
      res
        .status(400)
        .type("html")
        .send(message("Refused", apiError(result.body)));
      return;
    }
    res.redirect(
      303,
      `/org/${req.params.id}/services/${String(result.body.relyingPartyServiceId)}`,
    );
  });

  app.get("/org/:id/services/:sid", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.sid)) return void res.status(404).end();
    await renderService(res, token, req.params.id, req.params.sid);
  });

  app.post("/org/:id/services/:sid/intended-uses", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.sid)) return void res.status(404).end();
    const result = await options.api.call(
      "POST",
      `organisations/${req.params.id}/services/${req.params.sid}/intended-uses`,
      {
        session: token,
        body: {
          purpose: [{ lang: "en", value: String(req.body?.purpose ?? "") }],
          credentials: [
            {
              format: "dc+sd-jwt",
              types: ["urn:eudi:pid:1"],
              claims: parseClaimLines(String(req.body?.claims ?? "")),
            },
          ],
        },
      },
    );
    if (result.status !== 201)
      return renderService(res, token, req.params.id, req.params.sid, apiError(result.body));
    res.redirect(303, `/org/${req.params.id}/services/${req.params.sid}`);
  });

  app.post("/org/:id/services/:sid/access-certificates", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.sid)) return void res.status(404).end();
    const result = await options.api.call(
      "POST",
      `organisations/${req.params.id}/services/${req.params.sid}/access-certificates`,
      {
        session: token,
        body: {
          variant: String(req.body?.variant ?? ""),
          csrPem: String(req.body?.csrPem ?? ""),
          dnsNames: String(req.body?.dnsNames ?? "")
            .split(/\s+/)
            .filter(Boolean),
        },
      },
    );
    if (result.status !== 201)
      return renderService(res, token, req.params.id, req.params.sid, apiError(result.body));
    res.redirect(303, `/org/${req.params.id}/certificates/${String(result.body.id)}`);
  });

  app.post("/org/:id/services/:sid/registration-certificates", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.sid)) return void res.status(404).end();
    const intendedUseId =
      typeof req.body?.intendedUseId === "string" && req.body.intendedUseId
        ? req.body.intendedUseId
        : undefined;
    const result = await options.api.call(
      "POST",
      `organisations/${req.params.id}/services/${req.params.sid}/registration-certificates`,
      {
        session: token,
        body: {
          variant: String(req.body?.variant ?? ""),
          ...(intendedUseId ? { intendedUseId } : {}),
        },
      },
    );
    if (result.status !== 201)
      return renderService(res, token, req.params.id, req.params.sid, apiError(result.body));
    res.redirect(303, `/org/${req.params.id}/certificates/${String(result.body.id)}`);
  });

  app.get("/org/:id/certificates/:cid", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.cid)) return void res.status(404).end();
    const cert = await options.api.call(
      "GET",
      `organisations/${req.params.id}/certificates/${req.params.cid}`,
      { session: token },
    );
    if (cert.status !== 200)
      return void res
        .status(404)
        .type("html")
        .send(message("Not found", "No such certificate."));
    res
      .type("html")
      .send(certificatePage(req.params.id, cert.body as unknown as CertificateSummary));
  });

  app.get("/org/:id/certificates/:cid/download", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.cid)) return void res.status(404).end();
    const cert = await options.api.call(
      "GET",
      `organisations/${req.params.id}/certificates/${req.params.cid}`,
      { session: token },
    );
    const body = cert.body.body;
    if (cert.status !== 200 || typeof body !== "string") return void res.status(404).end();
    const isPem = cert.body.kind === "WRPAC";
    const name = `${String(cert.body.kind).toLowerCase()}-${String(cert.body.variant)}-${req.params.cid.slice(0, 8)}.${isPem ? "pem" : "jwt"}`;
    res.setHeader("content-disposition", `attachment; filename="${name}"`);
    res.type(isPem ? "application/x-pem-file" : "application/jwt").send(body);
  });

  app.post("/org/:id/certificates/:cid/revoke", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.cid)) return void res.status(404).end();
    await options.api.call(
      "POST",
      `organisations/${req.params.id}/certificates/${req.params.cid}/revoke`,
      { session: token },
    );
    res.redirect(303, `/org/${req.params.id}/certificates/${req.params.cid}`);
  });

  // --- the hosted verifier and runs (S4) -------------------------------------------------------

  app.post("/org/:id/services/:sid/verifier", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.sid)) return void res.status(404).end();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const uses = Object.entries(body)
      .filter(([k]) => /^rc_[0-9a-f-]{36}$/.test(k))
      .map(([k, v]) => ({ intendedUseId: k.slice(3), registrationVariant: String(v) }));
    const result = await options.api.call(
      "POST",
      `organisations/${req.params.id}/services/${req.params.sid}/verifier`,
      {
        session: token,
        body: { accessVariant: String(body.accessVariant ?? ""), uses },
      },
    );
    if (result.status !== 200)
      return renderService(res, token, req.params.id, req.params.sid, apiError(result.body));
    res.redirect(303, `/org/${req.params.id}/services/${req.params.sid}`);
  });

  app.post("/org/:id/services/:sid/runs", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.sid)) return void res.status(404).end();
    const interaction = req.body?.interaction === "QR" ? "QR" : "SAME_DEVICE";
    const result = await options.api.call(
      "POST",
      `organisations/${req.params.id}/services/${req.params.sid}/runs`,
      {
        session: token,
        body: { intendedUseId: String(req.body?.intendedUseId ?? ""), interaction },
      },
    );
    if (result.status !== 201)
      return renderService(res, token, req.params.id, req.params.sid, apiError(result.body));
    res.type("html").send(
      walletStep(String(result.body.walletUri ?? ""), interaction, {
        waitUrl: `/org/${req.params.id}/runs/${String(result.body.runId)}`,
        about:
          "Your wallet will be asked to present to this service's hosted verifier, with the certificates you configured.",
      }),
    );
  });

  app.get("/org/:id/runs/:rid", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.rid)) return void res.status(404).end();
    const run = await options.api.call(
      "GET",
      `organisations/${req.params.id}/runs/${req.params.rid}`,
      { session: token },
    );
    if (run.status !== 200)
      return void res.status(404).type("html").send(message("Not found", "No such run."));
    res.type("html").send(runPage(req.params.id, run.body as unknown as RunReport));
  });

  app.post("/org/:id/runs/:rid/observation", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.rid)) return void res.status(404).end();
    const b = req.body ?? {};
    const observation = OBSERVATIONS.some(([k]) => k === b.observation)
      ? String(b.observation)
      : "other";
    const note =
      typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 500) : undefined;
    await options.api.call(
      "POST",
      `organisations/${req.params.id}/runs/${req.params.rid}/observation`,
      {
        session: token,
        body: {
          walletBuild: String(b.walletBuild ?? "").slice(0, 100),
          checkRegistrationCertificates: ["on", "off", "unknown"].includes(
            b.checkRegistrationCertificates,
          )
            ? b.checkRegistrationCertificates
            : "unknown",
          observation,
          ...(note ? { note } : {}),
        },
      },
    );
    res.redirect(303, `/org/${req.params.id}/runs/${req.params.rid}`);
  });

  // --- the hosted PID issuer (S5) --------------------------------------------------------------

  app.post("/org/:id/services/:sid/issuer", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.sid)) return void res.status(404).end();
    const result = await options.api.call(
      "POST",
      `organisations/${req.params.id}/services/${req.params.sid}/issuer`,
      {
        session: token,
        body: {
          signingVariant: String(req.body?.signingVariant ?? ""),
          registrationVariant: String(req.body?.registrationVariant ?? ""),
        },
      },
    );
    if (result.status !== 200)
      return renderService(res, token, req.params.id, req.params.sid, apiError(result.body));
    res.redirect(303, `/org/${req.params.id}/services/${req.params.sid}`);
  });

  app.post("/org/:id/services/:sid/issuer/offers", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.sid)) return void res.status(404).end();
    const b = req.body ?? {};
    const interaction = b.interaction === "QR" ? "QR" : "SAME_DEVICE";
    const result = await options.api.call(
      "POST",
      `organisations/${req.params.id}/services/${req.params.sid}/issuer/offers`,
      {
        session: token,
        body: {
          givenName: String(b.givenName ?? ""),
          familyName: String(b.familyName ?? ""),
          birthdate: String(b.birthdate ?? ""),
          birthCountry: String(b.birthCountry ?? "").toUpperCase(),
          nationalities: String(b.nationalities ?? "")
            .toUpperCase()
            .split(/[\s,]+/)
            .filter(Boolean),
        },
      },
    );
    if (result.status !== 201)
      return renderService(res, token, req.params.id, req.params.sid, apiError(result.body));
    res.type("html").send(
      walletStep(String(result.body.offerUri ?? ""), interaction, {
        waitUrl: `/org/${req.params.id}/issuances/${String(result.body.id)}`,
        about:
          "Your wallet will be offered a synthetic TEST PID from this service's hosted issuer.",
      }),
    );
  });

  app.get("/org/:id/issuances/:iid", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.iid)) return void res.status(404).end();
    const view = await options.api.call(
      "GET",
      `organisations/${req.params.id}/issuances/${req.params.iid}`,
      { session: token },
    );
    if (view.status !== 200)
      return void res.status(404).type("html").send(message("Not found", "No such issuance."));
    res
      .type("html")
      .send(issuancePage(req.params.id, view.body as unknown as IssuanceStatusView));
  });

  app.post("/org/:id/issuances/:iid/revoke", async (req, res) => {
    const token = requireSession(req, res);
    if (!token || !ids(req.params.id, req.params.iid)) return void res.status(404).end();
    await options.api.call(
      "POST",
      `organisations/${req.params.id}/issuances/${req.params.iid}/revoke`,
      { session: token },
    );
    res.redirect(303, `/org/${req.params.id}/issuances/${req.params.iid}`);
  });

  app.use((_req, res) => {
    res.status(404).type("html").send(page("Not found", "<h1>Not found</h1>"));
  });

  // An API that cannot be reached must not leak a stack trace.
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res
      .status(502)
      .type("html")
      .send(message("Unavailable", "The sandbox is unavailable right now."));
  });

  return app;
}
