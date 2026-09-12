import { mintStartToken } from "@edtp/start-token";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { loadConfig } from "./config.js";
import type { SafeHtml } from "./html.js";
import { type Interaction, InteractionCache } from "./interaction-cache.js";
import { CONSOLE_CSS, CONTENT_SECURITY_POLICY, notice, page } from "./layout.js";
import { Logger } from "./logger.js";
import { PlatformApiError, PlatformClient } from "./platform-client.js";
import { checkInteractionReachability } from "./reachability.js";
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

  // --- test driver ----------------------------------------------------------------------------

  app.get("/", (_request, response) => {
    render(
      response,
      "Test driver",
      testDriverView({ sameDeviceAvailable: config.TEST_START_PUBLIC_URL !== undefined }),
      true,
    );
  });

  app.post("/presentations", async (request, response) => {
    const parsed = createPresentationForm.safeParse(request.body);
    if (!parsed.success) {
      response.status(400);
      render(
        response,
        "Test driver",
        testDriverView({
          sameDeviceAvailable: config.TEST_START_PUBLIC_URL !== undefined,
          error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        }),
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
        testDriverView({
          sameDeviceAvailable: false,
          error:
            "Same-device needs TEST_START_PUBLIC_URL, because the phone has to open a publicly " +
            "reachable page. Use QR, or configure the start page.",
        }),
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
        testDriverView({
          sameDeviceAvailable: config.TEST_START_PUBLIC_URL !== undefined,
          error: message,
        }),
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
