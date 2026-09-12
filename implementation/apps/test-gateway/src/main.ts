import http from "node:http";
import { z } from "zod";
import { ENGINE_RULES, isAllowed, PLATFORM_RULES, type Rule } from "./allow-list.js";

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
  /** Bound to every interface: a tunnel connects to it, and on a laptop that means all of them. */
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

const createProxy = (
  name: "engine" | "platform",
  rules: readonly Rule[],
  target: string,
  config: GatewayConfig,
): http.Server =>
  http.createServer((request, response) => {
    const method = request.method ?? "GET";
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

    const upstream = new URL(request.url ?? "/", target);
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
