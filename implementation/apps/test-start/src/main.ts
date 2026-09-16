import { isPermittedInteractionUri, verifyStartToken } from "@edtp/start-token";
import express, { type Request, type Response } from "express";
import { z } from "zod";

/**
 * The public start page — the **only** publicly reachable part of the web interface.
 *
 * ## What it can do, which is almost nothing
 *
 * It verifies a token the console signed and offers the visitor a link to the wallet. That is all.
 *
 * - **No platform API credential.** It has none configured, so it cannot create, read or enumerate
 *   anything. Compromising it yields a signature-verifying redirector, not access to the platform.
 * - **No database, no session, no cookie.**
 * - **One route that matters**, and it accepts only a token this deployment's secret signed.
 *
 * That is the whole design: a same-device test needs the page that opens the wallet to be on the phone,
 * and `docs/test-session-gateway.md` §1c says nothing public may reach a management route. So the
 * publicly reachable thing is given the finished interaction URI and no way to obtain another.
 *
 * ## Why a page rather than a `302`
 *
 * Two reasons. A custom-scheme redirect (`openid4vp://`) issued automatically is unreliable across
 * Android browsers and is sometimes silently dropped; a user gesture is the dependable trigger. And a
 * visitor should see what is about to happen before their wallet opens — this is a test page, and an
 * unexplained app launch is worse than a button.
 *
 * ## Replay
 *
 * Tokens expire in two minutes and each carries a nonce, which is refused a second time. The nonce set
 * is in memory, so a restart forgets it and a single instance is assumed — the same limitation the
 * platform's background jobs carry (`security-limitations.md` O1). Expiry is the real control; the nonce
 * check just makes a shared link useless immediately rather than within two minutes.
 */

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * Deliberately **not** `PORT`, and neither is the bind host.
   *
   * The console and this page are normally configured from one place — a compose file, or one shell
   * environment — and `PORT` would silently put both on the same number. That is not a hypothetical: it
   * happened on the first run, and the two processes bound the same port on different interfaces
   * without either reporting an error, which is about the worst way to discover a clash.
   */
  TEST_START_PORT: z.coerce.number().int().min(1).max(65_535).default(3201),
  /** Shared with the console. The only secret this process holds. */
  START_TOKEN_SECRET: z.string().min(32),
  /**
   * Bound to `0.0.0.0` by default, unlike the console: this one is *meant* to be reachable, through the
   * gateway's allow-list and nothing else.
   */
  TEST_START_BIND_HOST: z.string().min(1).default("0.0.0.0"),
});

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

/**
 * Nonces already used. Bounded, because a public endpoint must not let a caller grow a process's memory.
 * When the cap is reached the oldest are dropped, which at worst allows a replay of a token that is
 * about to expire anyway.
 */
const MAX_SEEN = 5_000;
const seenNonces = new Set<string>();

const rememberNonce = (nonce: string): boolean => {
  if (seenNonces.has(nonce)) {
    return false;
  }
  if (seenNonces.size >= MAX_SEEN) {
    const oldest = seenNonces.values().next();
    if (!oldest.done) {
      seenNonces.delete(oldest.value);
    }
  }
  seenNonces.add(nonce);
  return true;
};

const shell = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #fbfbfa; color: #1d1d1b;
  }
  @media (prefers-color-scheme: dark) { body { background: #16171a; color: #e9e9e6; } }
  main { max-width: 30rem; text-align: center; }
  .banner {
    background: #8a1c1c; color: #fff; font-size: 11px; font-weight: 700; letter-spacing: .04em;
    padding: 6px 10px; border-radius: 4px; margin-bottom: 24px;
  }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #5f5f5a; margin: 0 0 20px; }
  @media (prefers-color-scheme: dark) { p { color: #a0a09a; } }
  a.go {
    display: inline-block; padding: 16px 28px; border-radius: 8px; background: #1a4f8a;
    color: #fff; font-weight: 700; text-decoration: none; font-size: 17px;
  }
  code { font-family: ui-monospace, monospace; font-size: 12px; }
</style>
</head>
<body><main>
<div class="banner">EDTP TEST ENVIRONMENT · SYNTHETIC DATA ONLY · NOT A PRODUCTION SERVICE</div>
${body}
</main></body>
</html>
`;

const main = (): void => {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write(
      `test-start configuration is invalid — ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}\n`,
    );
    process.exit(1);
  }
  const config = parsed.data;

  const app = express();
  app.disable("x-powered-by");

  app.use((_request: Request, response: Response, next) => {
    response.setHeader(
      "content-security-policy",
      // No script at all, from anywhere. The page is a heading and a link; it needs none, and saying so
      // explicitly is cheaper than reviewing whether some future addition is safe.
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("cache-control", "no-store");
    // A public test page has no business being indexed.
    response.setHeader("x-robots-tag", "noindex, nofollow");
    next();
  });

  app.get("/s/:token", (request, response) => {
    const token = request.params.token ?? "";
    const result = verifyStartToken(
      config.START_TOKEN_SECRET,
      token,
      Math.floor(Date.now() / 1_000),
    );

    if (!result.ok) {
      // One message for every reason. A visitor learns nothing about whether a token was forged,
      // malformed or merely late; the operator learns it from the console, which knows what it issued.
      response
        .status(410)
        .type("html")
        .send(
          shell(
            "Link no longer valid",
            "<h1>This link is no longer valid</h1>" +
              "<p>Start the test again from the console and scan the new code.</p>",
          ),
        );
      return;
    }

    if (!isPermittedInteractionUri(result.payload.uri)) {
      // Defence against ourselves, not against forgery: the URI is signed. If a future change ever let a
      // token carry an `https://` URL, this page would become an open redirector that our own signature
      // vouches for.
      response
        .status(400)
        .type("html")
        .send(
          shell(
            "Unsupported link",
            "<h1>Unsupported link</h1><p>That token does not carry a wallet request.</p>",
          ),
        );
      return;
    }

    if (!rememberNonce(result.payload.nonce)) {
      response
        .status(410)
        .type("html")
        .send(
          shell(
            "Already used",
            "<h1>This link has already been used</h1>" +
              "<p>Start the test again from the console to get a new one.</p>",
          ),
        );
      return;
    }

    response
      .type("html")
      .send(
        shell(
          "Open your wallet",
          "<h1>Open your wallet</h1>" +
            "<p>Your wallet will be asked to present attributes to this test service. " +
            "Nothing here uses real personal data.</p>" +
            `<p><a class="go" href="${escapeHtml(result.payload.uri)}">Open wallet</a></p>` +
            `<p><code>${escapeHtml(result.payload.presentationId)}</code></p>`,
        ),
      );
  });

  // Everything else is 404, including `/`. Nothing advertises what this service is.
  app.use((_request, response) => {
    response.status(404).type("html").send(shell("Not found", "<h1>Not found</h1>"));
  });

  const server = app.listen(config.TEST_START_PORT, config.TEST_START_BIND_HOST, () => {
    process.stdout.write(
      `${JSON.stringify({
        time: new Date().toISOString(),
        level: "info",
        service: "test-start",
        message: "public start page listening",
        port: config.TEST_START_PORT,
        host: config.TEST_START_BIND_HOST,
      })}\n`,
    );
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

main();
