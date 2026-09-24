import http from "node:http";
import { clientKey, RateLimiter } from "@edtp/shared";
import { z } from "zod";
import { ENGINE_RULES, isAllowed, PLATFORM_RULES, type Rule } from "./allow-list.js";
import { hostedFormGate } from "./hosted-form-gate.js";

/**
 * The filtering reverse proxy that sits between a public tunnel and the stack.
 *
 * ## Why this exists rather than tunnel ingress rules
 *
 * A Cloudflare **quick tunnel** — the kind that needs no account and no domain — forwards every path on
 * its hostname to one local port. Pointed at the engine that would publish `POST /api/key-chain/import`
 * and every tenant route to the internet, protected by nothing but a client-credentials secret.
 * Path-level ingress rules need a *named* tunnel, which needs an account and a domain we do not have.
 *
 * So the filtering happens here, before the tunnel ever sees the stack. The tunnel points at this; this
 * points at the engine and the platform, both still bound to `127.0.0.1`.
 *
 * ## What it is not
 *
 * Not a security product, and not a substitute for network separation. It hides the Management API; it
 * does not secure it (`docs/security-limitations.md` O4). It is a test-session component: started by
 * hand, up only while a session is, synthetic data only.
 */

const schema = z.object({
  GATEWAY_ENGINE_PORT: z.coerce.number().int().min(1).max(65_535).default(3010),
  GATEWAY_PLATFORM_PORT: z.coerce.number().int().min(1).max(65_535).default(3011),
  /** The upstreams. Both loopback: the gateway is the only thing that reaches them. */
  GATEWAY_ENGINE_TARGET: z.string().url().default("http://127.0.0.1:3000"),
  GATEWAY_PLATFORM_TARGET: z.string().url().default("http://127.0.0.1:3100"),
  /**
   * G7 edge hardening — strips `statusCode`, `timestamp` and `path` from non-2xx JSON on wallet-facing
   * routes, preserving `redirect_uri`, `error` and `error_description`.
   *
   * **Off by default, and that is a decision rather than an oversight** (`test-session-gateway.md` §3).
   * With it on, a conformance run through this gateway would report G7 as absent when it is not, and the
   * whole value of that suite is that it describes the engine as it is. Forbidden during any run whose
   * purpose is to evidence an engine gap.
   */
  GATEWAY_STRIP_NONPROTOCOL_ERROR_KEYS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Compatibility with the pinned test wallet. **A demo workaround, off by default, and never on for a
   * run meant to evidence anything about the engine.** Two response rewrites, both needed together
   * for that wallet to complete an issuance against this engine; each exists because the two sides
   * disagree on something the specification leaves open. `interop-findings.md` A29.
   *
   * 1. **Token responses lose `authorization_details`.** The engine always returns them with
   *    `credential_identifiers` — falling back to the offer's configuration ids when the request
   *    carried none — and `eudi-lib-jvm-openid4vci-kt` 0.13.1 then refuses a credential request built
   *    by configuration id, which is the only kind Wallet Core 0.30.2 builds: *"Authorization detail
   *    type of openid_credential require usage of credential identifiers in credential request"*.
   *    For a pre-authorized code with none in the request, returning them is optional. Safe for the
   *    engine: its credential endpoint authorises from the access token's own claims.
   *
   * 2. **Issuer metadata gains `key_attestations_required` on the `attestation` proof type.** Wallet
   *    Core 0.30.2 has no plain JWT proof — every JWT proof carries a key attestation, which the
   *    engine resolves as signer method `custom` and refuses — so the issuer advertises only
   *    `attestation`, which the engine verifies against its wallet-provider trust list. But the
   *    engine publishes `key_attestations_required` only under `jwt`, and the wallet's library
   *    rejects any proof type without it. The value injected is the adapter's own
   *    (`iso_18045_basic`): a parser requirement, not a security property.
   */
  GATEWAY_PINNED_WALLET_COMPAT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Wallet-initiated issuance through a hosted form (`docs/test-session-gateway.md` §1e). For the
   * engine tenants listed, a browser arriving at `/issuers/{tenant}/authorize` is sent to the form
   * instead — the engine's own authorization endpoint mints a code for anyone who asks, so the form
   * must stand in front of it — and is let through only with the pass the platform gives the form on
   * a valid submission. All three set, or the feature is off and `/authorize` behaves as before.
   */
  GATEWAY_HOSTED_FORM_URL: z.string().url().optional(),
  GATEWAY_HOSTED_FORM_AUTHORIZE_SECRET: z.string().min(32).optional(),
  GATEWAY_HOSTED_FORM_TENANTS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  /** Bound to every interface: a tunnel connects to it, and on a laptop that means all of them. */
  /**
   * Milliseconds to hold a POST to an issuer's PAR or token endpoint before forwarding it. A demo
   * workaround for a fast phone clock against the engine's zero-tolerance `nbf` check (A29, item 4).
   * 0, the default, is off.
   */
  GATEWAY_ATTESTATION_SKEW_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(0),
  /**
   * Per-client limits, per minute (ADR 0010 §3); `0` disables one. The general limit counts every
   * request, refused ones included, so probing for paths is limited too. The other two cover what makes
   * the engine do real work: issuance (PAR, token, nonce, credential) and presentation responses.
   */
  GATEWAY_RATE_GENERAL_PER_MIN: z.coerce.number().int().min(0).default(300),
  GATEWAY_RATE_ISSUANCE_PER_MIN: z.coerce.number().int().min(0).default(30),
  GATEWAY_RATE_PRESENTATION_PER_MIN: z.coerce.number().int().min(0).default(30),
  GATEWAY_BIND_HOST: z.string().min(1).default("127.0.0.1"),
});

type GatewayConfig = Readonly<z.infer<typeof schema>>;

/** Keys OpenID4VP 1.0 Final §8.2 does not define in a direct-post response. See G7. */
const NON_PROTOCOL_ERROR_KEYS = ["statusCode", "timestamp", "path"] as const;

/**
 * Hop-by-hop headers, which belong to one connection and must not be forwarded (RFC 9110 §7.6.1).
 * Forwarding `connection` or `transfer-encoding` produces failures that look like protocol errors.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const log = (message: string, context: Record<string, unknown>): void => {
  process.stdout.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      service: "test-gateway",
      message,
      ...context,
    })}\n`,
  );
};

const deny = (
  response: http.ServerResponse,
  reason: string,
  context: Record<string, unknown>,
): void => {
  // Logged with the path and method, never a body or a header: a denied request is by definition from
  // someone we do not trust, and its contents are not ours to keep.
  log("denied", { reason, ...context });
  response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
  response.end('{"error":"not_found"}');
};

/** The work-heavy classes the per-minute limits distinguish. */
const ISSUANCE_ENDPOINT =
  /^\/issuers\/[A-Za-z0-9._-]+\/(authorize\/(par|token)|vci\/(credential|nonce|deferred_credential))$/;
const PRESENTATION_ENDPOINT = /^\/presentations\/[^/]+\//;

/** One set of limiters per proxy (engine, platform), created on first use. */
type Limits = Record<"general" | "issuance" | "presentation", RateLimiter>;
const limitSets = new Map<string, Limits>();
const limitsOf = (name: string, config: GatewayConfig): Limits => {
  let set = limitSets.get(name);
  if (!set) {
    const perMinute = (max: number) => new RateLimiter({ max, windowMs: 60_000 });
    set = {
      general: perMinute(config.GATEWAY_RATE_GENERAL_PER_MIN),
      issuance: perMinute(config.GATEWAY_RATE_ISSUANCE_PER_MIN),
      presentation: perMinute(config.GATEWAY_RATE_PRESENTATION_PER_MIN),
    };
    limitSets.set(name, set);
  }
  return set;
};

const rateLimited = (response: http.ServerResponse, retryAfterSeconds: number): void => {
  response.writeHead(429, {
    "content-type": "application/json",
    "retry-after": String(retryAfterSeconds),
    "cache-control": "no-store",
  });
  response.end('{"error":"rate_limited"}');
};

/** Endpoints that verify a client attestation: pushed authorization and token. */
const ATTESTED_ENDPOINT = /^\/issuers\/[A-Za-z0-9._-]+\/authorize\/(par|token)$/;

const createProxy = (
  name: "engine" | "platform",
  rules: readonly Rule[],
  target: string,
  config: GatewayConfig,
): http.Server =>
  http.createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const who = clientKey(request.headers, request.socket.remoteAddress);
    const limits = limitsOf(name, config);
    const general = limits.general.take(who);
    if (!general.allowed) {
      // The address is personal data and is not logged; the path class is enough to see a pattern.
      log("rate limited", { target: name, class: "general" });
      rateLimited(response, general.retryAfterSeconds);
      return;
    }
    // Parsed against a dummy base so the pathname is separated from the query. Matching the raw URL
    // would let `?x=/allowed/path` influence the decision.
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
    } catch {
      deny(response, "unparseable_url", { target: name, method });
      return;
    }

    if (!isAllowed(rules, method, pathname)) {
      deny(response, "not_on_allow_list", { target: name, method, path: pathname });
      return;
    }

    if (name === "engine" && method === "POST") {
      const cls = ISSUANCE_ENDPOINT.test(pathname)
        ? "issuance"
        : PRESENTATION_ENDPOINT.test(pathname)
          ? "presentation"
          : undefined;
      if (cls) {
        const d = limits[cls].take(who);
        if (!d.allowed) {
          log("rate limited", { target: name, class: cls });
          rateLimited(response, d.retryAfterSeconds);
          return;
        }
      }
    }

    let forwardUrl = request.url ?? "/";
    if (name === "engine") {
      const gate = hostedFormGate(config, method, forwardUrl);
      if (gate.kind === "redirect") {
        log("sent to the hosted form", {
          target: name,
          method,
          path: pathname,
          tenant: gate.tenant,
        });
        response.writeHead(302, { location: gate.location, "cache-control": "no-store" });
        response.end();
        return;
      }
      if (gate.kind === "refuse") {
        deny(response, gate.reason, { target: name, method, path: pathname });
        return;
      }
      if (gate.kind === "pass") forwardUrl = gate.forwardUrl;
    }

    // A29 (4): the engine checks a client attestation's `nbf` with zero tolerance, so a phone whose
    // clock runs a couple of seconds fast is refused at PAR and at the token endpoint ("jwt 'nbf' is
    // in the future"). Holding those two requests briefly lets the engine's clock pass the `nbf`.
    // Timing only — nothing is rewritten — and only with the demo compatibility switch on.
    if (
      name === "engine" &&
      method === "POST" &&
      config.GATEWAY_ATTESTATION_SKEW_DELAY_MS > 0 &&
      ATTESTED_ENDPOINT.test(pathname)
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, config.GATEWAY_ATTESTATION_SKEW_DELAY_MS),
      );
    }

    const upstream = new URL(forwardUrl, target);
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(key.toLowerCase())) {
        headers[key] = value;
      }
    }
    // The upstream's own host, not the tunnel's. The engine builds wallet-facing URLs from
    // `ENGINE_PUBLIC_URL` rather than from this header, but sending a public hostname to a service that
    // trusted it would be a quiet way to hand over control of what it emits.
    headers["host"] = upstream.host;

    const proxied = http.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        path: `${upstream.pathname}${upstream.search}`,
        method,
        headers,
      },
      (upstreamResponse) => {
        const status = upstreamResponse.statusCode ?? 502;
        const outgoing: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(key.toLowerCase())) {
            outgoing[key] = value;
          }
        }

        const contentType = String(upstreamResponse.headers["content-type"] ?? "");

        const injectKeyAttestation =
          config.GATEWAY_PINNED_WALLET_COMPAT &&
          method === "GET" &&
          ISSUER_METADATA.test(pathname) &&
          status >= 200 &&
          status < 300 &&
          contentType.includes("application/json");

        if (injectKeyAttestation) {
          const mdChunks: Buffer[] = [];
          upstreamResponse.on("data", (chunk: Buffer) => mdChunks.push(chunk));
          upstreamResponse.on("end", () => {
            let out = Buffer.concat(mdChunks).toString("utf8");
            try {
              const md = JSON.parse(out) as {
                credential_configurations_supported?: Record<
                  string,
                  { proof_types_supported?: Record<string, Record<string, unknown>> }
                >;
              };
              let injected = 0;
              for (const cfg of Object.values(md.credential_configurations_supported ?? {})) {
                const attestation = cfg.proof_types_supported?.["attestation"];
                if (attestation && !("key_attestations_required" in attestation)) {
                  attestation["key_attestations_required"] = {
                    key_storage: ["iso_18045_basic"],
                  };
                  injected += 1;
                }
              }
              if (injected > 0) {
                out = JSON.stringify(md);
                log("injected key_attestations_required into attestation proof types", {
                  path: pathname,
                  configurations: injected,
                });
              }
            } catch {
              // Not JSON after all: passed through untouched.
            }
            delete outgoing["content-length"];
            response.writeHead(status, {
              ...outgoing,
              "content-length": Buffer.byteLength(out),
            });
            response.end(out);
          });
          return;
        }

        const stripTokenDetails =
          config.GATEWAY_PINNED_WALLET_COMPAT &&
          method === "POST" &&
          TOKEN_ENDPOINT.test(pathname) &&
          status >= 200 &&
          status < 300 &&
          contentType.includes("application/json");

        if (stripTokenDetails) {
          // Buffered: a token response is small. **The body is never logged** — it carries the
          // access token and the refresh token.
          const tokenChunks: Buffer[] = [];
          upstreamResponse.on("data", (chunk: Buffer) => tokenChunks.push(chunk));
          upstreamResponse.on("end", () => {
            let out = Buffer.concat(tokenChunks).toString("utf8");
            try {
              const parsed: unknown = JSON.parse(out);
              if (
                typeof parsed === "object" &&
                parsed !== null &&
                !Array.isArray(parsed) &&
                "authorization_details" in parsed
              ) {
                const copy = { ...(parsed as Record<string, unknown>) };
                delete copy["authorization_details"];
                out = JSON.stringify(copy);
                log("stripped authorization_details from a token response", { path: pathname });
              }
            } catch {
              // Not JSON after all: passed through untouched.
            }
            delete outgoing["content-length"];
            response.writeHead(status, {
              ...outgoing,
              "content-length": Buffer.byteLength(out),
            });
            response.end(out);
          });
          return;
        }

        const shouldStrip =
          config.GATEWAY_STRIP_NONPROTOCOL_ERROR_KEYS &&
          status >= 300 &&
          contentType.includes("application/json");

        if (!shouldStrip) {
          response.writeHead(status, outgoing);
          upstreamResponse.pipe(response);
          return;
        }

        // Buffered only on the stripping path, and only for a non-2xx JSON body, which is small by
        // construction. Everything else streams.
        const chunks: Buffer[] = [];
        upstreamResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamResponse.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let out = body;
          try {
            const parsed: unknown = JSON.parse(body);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              const copy = { ...(parsed as Record<string, unknown>) };
              const removed = NON_PROTOCOL_ERROR_KEYS.filter((key) => key in copy);
              for (const key of removed) {
                delete copy[key];
              }
              if (removed.length > 0) {
                // The keys removed, never the body: it is an error from a wallet exchange.
                log("stripped non-protocol error keys", { path: pathname, removed });
                out = JSON.stringify(copy);
              }
            }
          } catch {
            // Not JSON after all. Passed through untouched — this filter removes keys, it never
            // rewrites something it did not understand.
          }
          delete outgoing["content-length"];
          response.writeHead(status, { ...outgoing, "content-length": Buffer.byteLength(out) });
          response.end(out);
        });
      },
    );

    proxied.on("error", (error: Error) => {
      log("upstream error", { target: name, path: pathname, error: error.message });
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      response.end('{"error":"upstream_unavailable"}');
    });

    request.pipe(proxied);
  });

/** The engine's token endpoint for any issuer tenant — the only place the token transform applies. */
const TOKEN_ENDPOINT = /^\/issuers\/[A-Za-z0-9._-]+\/authorize\/token$/;

/** The Wallet-facing Credential Issuer metadata document. */
const ISSUER_METADATA = /^\/\.well-known\/openid-credential-issuer\/issuers\/[A-Za-z0-9._-]+$/;

const main = (): void => {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write(
      `test-gateway configuration is invalid — ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}\n`,
    );
    process.exit(1);
  }
  const config = parsed.data;

  if (config.GATEWAY_PINNED_WALLET_COMPAT) {
    log("pinned-wallet compatibility is ON", {
      warning:
        "a demo workaround (A29): token responses and issuer metadata through this gateway are not " +
        "what the engine sent, so nothing observed through it evidences the engine's behaviour",
    });
  }

  if (config.GATEWAY_STRIP_NONPROTOCOL_ERROR_KEYS) {
    log("G7 stripping is ON", {
      warning:
        "a conformance run through this gateway would report G7 as absent when it is not; " +
        "record it in the run record",
    });
  }

  const engine = createProxy("engine", ENGINE_RULES, config.GATEWAY_ENGINE_TARGET, config);
  const platform = createProxy(
    "platform",
    PLATFORM_RULES,
    config.GATEWAY_PLATFORM_TARGET,
    config,
  );

  engine.listen(config.GATEWAY_ENGINE_PORT, config.GATEWAY_BIND_HOST, () => {
    log("engine gateway listening", {
      port: config.GATEWAY_ENGINE_PORT,
      target: config.GATEWAY_ENGINE_TARGET,
      rules: ENGINE_RULES.length,
    });
  });
  platform.listen(config.GATEWAY_PLATFORM_PORT, config.GATEWAY_BIND_HOST, () => {
    log("platform gateway listening", {
      port: config.GATEWAY_PLATFORM_PORT,
      target: config.GATEWAY_PLATFORM_TARGET,
      rules: PLATFORM_RULES.length,
    });
  });

  const shutdown = (): void => {
    engine.close();
    platform.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

main();
