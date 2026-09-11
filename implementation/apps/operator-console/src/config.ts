import { z } from "zod";

/**
 * Console configuration.
 *
 * Validated at startup, like the platform API's, so a misconfiguration is a boot failure rather than a
 * surprise on the first request. No secret has a default.
 *
 * Two things here are deliberately awkward, and should stay awkward:
 *
 * - `CONSOLE_TENANT_API_KEY` is a **tenant bearer token held by a server process**. It is the whole
 *   reason the console is server-rendered: the browser never sees it. Anyone tempted to pass it to
 *   client-side code should read `docs/web-interface-proposal.md` §3.2 first.
 * - `CONSOLE_BIND_HOST` defaults to `127.0.0.1` and the console refuses to bind anywhere else unless
 *   `CONSOLE_ALLOW_NON_LOCAL_BIND` is set. The console is a management surface, and
 *   `docs/test-session-gateway.md` §1c says management is never publicly exposed.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3200),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /** Where the console reaches the platform API. Server-to-server, normally over localhost. */
  PLATFORM_API_BASE_URL: z.string().url(),
  PLATFORM_API_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),

  /** A tenant API key. Scopes everything the console can see — the tenant comes from the key. */
  CONSOLE_TENANT_API_KEY: z.string().min(16),

  /**
   * The bootstrap administrative key, needed only to create a tenant.
   *
   * Optional: a console configured without it simply has no "create tenant" screen, which is the right
   * default. Creating tenants is a rare, privileged act and does not belong in a always-on session.
   */
  PLATFORM_ADMIN_API_KEY: z.string().min(32).optional(),

  /** Shared with the public start page. Signs the interaction-URI hand-off. */
  START_TOKEN_SECRET: z.string().min(32),

  /**
   * Public base URL of the test-start page, as the **phone** will reach it.
   *
   * Optional, and its absence is meaningful rather than an error: without it the console can still run
   * cross-device (`QR`) tests, where the QR carries the OpenID4VP request and no page of ours is
   * involved. Same-device on a phone is what needs a publicly reachable page.
   */
  TEST_START_PUBLIC_URL: z.string().url().optional(),

  /** Operator login. A single shared credential — the console has no user model by design. */
  CONSOLE_OPERATOR_PASSWORD: z.string().min(16),
  /** Signs the session cookie. Distinct from `START_TOKEN_SECRET`: different trust, different key. */
  CONSOLE_SESSION_SECRET: z.string().min(32),
  CONSOLE_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(28_800),

  CONSOLE_BIND_HOST: z.string().min(1).default("127.0.0.1"),
  /**
   * Binding off-localhost is an explicit, loud decision rather than a config typo.
   *
   * There is one legitimate reason: a container, where the console is bound to `0.0.0.0` inside and
   * published to `127.0.0.1` by the host. That is what the compose service does.
   */
  CONSOLE_ALLOW_NON_LOCAL_BIND: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type ConsoleConfig = Readonly<z.infer<typeof schema>>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): ConsoleConfig => {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`operator console configuration is invalid — ${detail}`);
  }
  const config = parsed.data;

  const local = config.CONSOLE_BIND_HOST === "127.0.0.1" || config.CONSOLE_BIND_HOST === "::1";
  if (!local && !config.CONSOLE_ALLOW_NON_LOCAL_BIND) {
    throw new Error(
      `refusing to bind the operator console to ${config.CONSOLE_BIND_HOST}: it is a management ` +
        "surface and must not be publicly reachable (docs/test-session-gateway.md §1c). Set " +
        "CONSOLE_ALLOW_NON_LOCAL_BIND=true only when something else — a container boundary — keeps " +
        "it local.",
    );
  }

  if (config.CONSOLE_SESSION_SECRET === config.START_TOKEN_SECRET) {
    throw new Error(
      "CONSOLE_SESSION_SECRET and START_TOKEN_SECRET must differ: one authenticates the operator to " +
        "this console, the other vouches for a URI to a public page. Sharing a key would let a leak " +
        "of either become a forgery of both.",
    );
  }

  return Object.freeze(config);
};
