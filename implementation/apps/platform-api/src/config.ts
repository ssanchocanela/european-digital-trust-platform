import { z } from "zod";

/**
 * Environment configuration.
 *
 * Validated at startup and nowhere else, so a misconfiguration is a boot failure rather
 * than a runtime surprise on the first request. No secret has a default: a missing
 * `PLATFORM_ADMIN_API_KEY` or engine credential must stop the process, not silently fall
 * back to a well-known value.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /** Platform database. Separate from the engine's — see ADR 0001. */
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /**
   * Bootstrap administrative key, used only to create the first tenant. Tenant-scoped
   * keys are issued per tenant afterwards.
   */
  PLATFORM_ADMIN_API_KEY: z.string().min(32),

  /** Engine base URL. Must not be publicly exposed — see `docs/security-limitations.md`. */
  ENGINE_BASE_URL: z.string().url(),
  ENGINE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),

  /**
   * Engine credentials, as `engineTenantRef=clientId:clientSecret` entries separated by
   * commas. One entry per Relying Party Instance, because the engine scopes every call to
   * the tenant of the presenting token (ADR 0002 Decision 3).
   */
  ENGINE_TENANT_CREDENTIALS: z.string().min(1),

  /** Public base URL of this API, used for same-device return URLs. */
  PLATFORM_PUBLIC_URL: z.string().url(),

  /** Background job cadence. */
  JOB_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
});

export type PlatformConfig = Readonly<z.infer<typeof schema>> & {
  readonly engineCredentials: ReadonlyMap<
    string,
    { readonly clientId: string; readonly clientSecret: string }
  >;
};

const parseEngineCredentials = (
  raw: string,
): Map<string, { clientId: string; clientSecret: string }> => {
  const map = new Map<string, { clientId: string; clientSecret: string }>();
  for (const entry of raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)) {
    const eq = entry.indexOf("=");
    const colon = entry.indexOf(":", eq + 1);
    if (eq <= 0 || colon <= eq + 1) {
      throw new Error(
        "ENGINE_TENANT_CREDENTIALS entries must look like " +
          "'engineTenantRef=clientId:clientSecret', separated by commas.",
      );
    }
    map.set(entry.slice(0, eq), {
      clientId: entry.slice(eq + 1, colon),
      clientSecret: entry.slice(colon + 1),
    });
  }
  if (map.size === 0) {
    throw new Error("ENGINE_TENANT_CREDENTIALS must contain at least one entry.");
  }
  return map;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): PlatformConfig => {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return {
    ...parsed.data,
    engineCredentials: parseEngineCredentials(parsed.data.ENGINE_TENANT_CREDENTIALS),
  };
};

export const CONFIG = Symbol("PlatformConfig");
