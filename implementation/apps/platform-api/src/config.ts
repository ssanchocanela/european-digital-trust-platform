import { z } from "zod";

/**
 * Environment configuration.
 *
 * Validated at startup and nowhere else, so a misconfiguration is a boot failure rather
 * than a runtime surprise on the first request. No secret has a default: a missing
 * `PLATFORM_ADMIN_API_KEY` or engine credential must stop the process, not silently fall
 * back to a well-known value.
 */
/** Compose passes an unset variable as `""`; for an optional setting that means "not set". */
const unsetIfEmpty = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), inner);

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
  /** Engine trust list of wallet providers. Unset: no wallet attestation at the token endpoint. */
  ENGINE_WALLET_PROVIDER_TRUST_LIST_ID: z.string().min(1).optional(),
  /**
   * Issuer trust lists loaded into the engine, as `<trust anchor source ref>=<engine list id>`
   * pairs separated by commas. The ref is the list's published URL, as a policy names it; the id is
   * what `scripts/load-issuer-trust-list.mjs` created. A policy naming a source not listed here is
   * refused — never verified without issuer trust (`docs/interop-findings.md` A30).
   */
  ENGINE_ISSUER_TRUST_LISTS: z
    .string()
    .default("")
    .transform((value, ctx) => {
      const map: Record<string, string> = {};
      for (const pair of value
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)) {
        const at = pair.lastIndexOf("=");
        const ref = pair.slice(0, at);
        const id = pair.slice(at + 1);
        if (at <= 0 || !id || !/^https:\/\//.test(ref)) {
          ctx.addIssue({ code: "custom", message: `not an https-ref=id pair: ${pair}` });
          return z.NEVER;
        }
        map[ref] = id;
      }
      return map;
    }),

  /** Public base URL of this API, used for same-device return URLs. */
  PLATFORM_PUBLIC_URL: z.string().url(),

  /** Background job cadence. */
  JOB_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  /**
   * PID-during-issuance: require a PID presentation as the authorization step of an issuance,
   * reusing a verification policy. **Off by default until a wallet test passes.**
   *
   * The engine supports it natively (`Oid4VpAuthorizationServerConfig`), so the platform side is a
   * wiring decision rather than a build — but it has never been exercised end to end, and turning on
   * an unverified flow by default would mean shipping something whose behaviour nobody has observed.
   *
   * Note what enabling it does to the platform's role: the issuer becomes a **Relying Party** for the
   * duration of the PID presentation. See `docs/issuer-trust-model.md`.
   */
  FEATURE_PID_DURING_ISSUANCE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),

  // --- wallet-initiated issuance through a hosted form ------------------------------------
  //
  // All unset by default, and then the feature is simply off: no attribute provider is registered
  // on the engine, and the hosted-form and engine routes refuse every request.

  /**
   * Where the engine reaches this API to ask for held claims — the compose-internal origin, never
   * the public one: `http://platform-api:3100`. The engine's outbound URL policy must allow it.
   */
  ENGINE_ATTRIBUTE_PROVIDER_BASE_URL: unsetIfEmpty(z.string().url().optional()),
  /** The key the engine presents on that call. A secret, shared with nothing else. */
  ENGINE_ATTRIBUTE_PROVIDER_KEY: unsetIfEmpty(z.string().min(32).optional()),
  /** The secret the hosted form presents when it submits. */
  HOSTED_FORM_SECRET: unsetIfEmpty(z.string().min(32).optional()),
  /**
   * Signs the hand-back from the form to the engine's authorization endpoint, which the test gateway
   * verifies before letting the browser through. Shared with the gateway and nothing else — it must
   * differ from `HOSTED_FORM_SECRET`, or the form could mint its own passes.
   */
  HOSTED_FORM_AUTHORIZE_SECRET: unsetIfEmpty(z.string().min(32).optional()),
  /**
   * The issuance policies a hosted form may submit to, as `tenantId:policyId` entries separated by
   * commas. A policy not listed here is refused: the form holds one secret, not a tenant's key.
   */
  HOSTED_FORM_POLICIES: z
    .string()
    .default("")
    .transform((value, ctx) => {
      const out: { tenantId: string; policyId: string }[] = [];
      for (const entry of value
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean)) {
        const [tenantId, policyId, extra] = entry.split(":");
        if (!tenantId || !policyId || extra !== undefined) {
          ctx.addIssue({ code: "custom", message: `not a tenantId:policyId pair: ${entry}` });
          return z.NEVER;
        }
        out.push({ tenantId, policyId });
      }
      return out;
    }),
  /**
   * A logo for the Credential Issuer's display, per engine tenant, as `engineTenantRef=https-url`
   * pairs. The wallet shows it beside every document from that issuer.
   */
  ENGINE_ISSUER_BRANDING: z
    .string()
    .default("")
    .transform((value, ctx) => {
      const map: Record<string, { logoUri: string }> = {};
      for (const pair of value
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)) {
        const at = pair.indexOf("=");
        const ref = pair.slice(0, at);
        const uri = pair.slice(at + 1);
        if (at <= 0 || !/^https:\/\//.test(uri)) {
          ctx.addIssue({
            code: "custom",
            message: `not an engineTenantRef=https-url pair: ${pair}`,
          });
          return z.NEVER;
        }
        map[ref] = { logoUri: uri };
      }
      return map;
    }),
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
  const d = parsed.data;
  if (
    d.HOSTED_FORM_SECRET &&
    d.HOSTED_FORM_AUTHORIZE_SECRET &&
    d.HOSTED_FORM_SECRET === d.HOSTED_FORM_AUTHORIZE_SECRET
  ) {
    // The form holds the first; a pass through the gateway needs the second. Equal, the form could
    // mint its own passes and the gateway's check would prove nothing.
    throw new Error(
      "Invalid environment configuration:\n  HOSTED_FORM_AUTHORIZE_SECRET must differ from HOSTED_FORM_SECRET",
    );
  }
  if (
    Boolean(d.ENGINE_ATTRIBUTE_PROVIDER_BASE_URL) !== Boolean(d.ENGINE_ATTRIBUTE_PROVIDER_KEY)
  ) {
    throw new Error(
      "Invalid environment configuration:\n  ENGINE_ATTRIBUTE_PROVIDER_BASE_URL and ENGINE_ATTRIBUTE_PROVIDER_KEY are set together or not at all",
    );
  }
  return {
    ...parsed.data,
    engineCredentials: parseEngineCredentials(parsed.data.ENGINE_TENANT_CREDENTIALS),
  };
};

export const CONFIG = Symbol("PlatformConfig");
