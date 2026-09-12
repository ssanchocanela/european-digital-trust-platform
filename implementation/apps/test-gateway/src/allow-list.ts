/**
 * The allow-list from `docs/test-session-gateway.md` §1, as enforced code.
 *
 * That document said an allow-list which lives in a document is a wish. This is the same list, and it
 * is the only thing standing between a public tunnel and the engine's **Management API** — which sits
 * under `/api` on the *same port* as the wallet-facing Protocol API, protected by nothing but a
 * client-credentials secret (`CLAUDE.md` §6.20).
 *
 * ## Default deny, and `404` rather than `403`
 *
 * A path that is not listed is answered `404`, not `403`. `403` confirms that something is there, which
 * is exactly what an allow-list is trying not to say. The negative checks in the gateway document treat
 * a `401` on an `/api/*` probe as a **failure** for the same reason: it proves the endpoint is
 * reachable.
 *
 * ## Anchored, and matched on the path alone
 *
 * Every pattern is anchored at both ends and matched against the URL's pathname with the query string
 * removed. An unanchored pattern is how `/api/tenant?x=/presentations/1/oid4vp` becomes reachable.
 */

export interface Rule {
  readonly methods: readonly string[];
  readonly pattern: RegExp;
  /** What this exists for, so a reviewer can tell a needed route from an accumulated one. */
  readonly why: string;
}

/** A UUID or a similar opaque identifier. Not `.*`, which would match a path separator. */
const ID = "[A-Za-z0-9_.:-]+";

/**
 * The engine's wallet-facing Protocol API.
 *
 * Everything here is something a wallet fetches during a presentation or an issuance. `/api/*`,
 * `/docs*`, `/health`, `/storage/*` and `/` are absent — deliberately, and each of them is a probe in
 * the negative checks.
 */
export const ENGINE_RULES: readonly Rule[] = [
  {
    methods: ["GET"],
    pattern: new RegExp(
      `^/\\.well-known/(openid-credential-issuer|oauth-authorization-server|jwks\\.json)/issuers/${ID}(/(authorization-servers/${ID}|chained-as|chained-as-vp))?$`,
    ),
    why: "IaaS — Credential Issuer, authorization server and key metadata",
  },
  {
    methods: ["GET", "POST"],
    pattern: new RegExp(`^/presentations/${ID}/oid4vp(/request(/no-redirect)?)?$`),
    why: "VaaS — the signed request object, and the vp_token response",
  },
  {
    methods: ["GET"],
    pattern: new RegExp(`^/issuers/${ID}/vci/credential-offers/${ID}$`),
    why: "IaaS — resolving a credential offer",
  },
  {
    methods: ["POST"],
    pattern: new RegExp(
      `^/issuers/${ID}/vci/(credential|nonce|notification|deferred_credential)$`,
    ),
    why: "IaaS — the credential, nonce, notification and deferred endpoints",
  },
  {
    methods: ["GET"],
    pattern: new RegExp(`^/issuers/${ID}/authorize$`),
    why: "IaaS — the authorization endpoint",
  },
  {
    methods: ["POST"],
    pattern: new RegExp(`^/issuers/${ID}/authorize/(par|token)$`),
    why: "IaaS — pushed authorization and token",
  },
  {
    methods: ["GET"],
    pattern: new RegExp(`^/issuers/${ID}/status-management/status-list/${ID}$`),
    why: "Revocation — status list retrieval",
  },
  {
    methods: ["GET"],
    pattern: new RegExp(`^/issuers/${ID}/credentials-metadata/vct/${ID}$`),
    why: "IaaS — VCT metadata",
  },
];

/**
 * The platform. **One route.**
 *
 * Where the wallet returns the user's browser after a same-device flow. It is already `@Public()` and
 * deliberately minimal — it echoes the id and a sentence, and reveals no outcome. Every other platform
 * route is tenant and provider management.
 */
export const PLATFORM_RULES: readonly Rule[] = [
  {
    methods: ["GET"],
    pattern: new RegExp(`^/v1/presentations/${ID}/return$`),
    why: "VaaS same-device — the browser return page",
  },
];

/**
 * Whether a request is allowed.
 *
 * The method is part of the decision. `POST /presentations/{id}/oid4vp/request` is legitimate;
 * `DELETE` on the same path is not, and an allow-list that ignored the method would pass it through to
 * see what the engine did with it.
 */
export const isAllowed = (rules: readonly Rule[], method: string, pathname: string): boolean =>
  rules.some(
    (rule) => rule.methods.includes(method.toUpperCase()) && rule.pattern.test(pathname),
  );

/**
 * The paths the gateway must refuse, checked before any wallet touches it.
 *
 * Kept beside the rules rather than in a shell script, so a rule added carelessly and a probe that
 * would catch it live in the same file and are reviewed together.
 */
export const NEGATIVE_PROBES: readonly {
  readonly target: "engine" | "platform";
  readonly path: string;
  readonly why: string;
}[] = [
  { target: "engine", path: "/api/docs-json", why: "the Management API's own description" },
  { target: "engine", path: "/api/tenant", why: "tenant creation" },
  { target: "engine", path: "/api/key-chain", why: "key-chain import — the worst one" },
  { target: "engine", path: "/api/verifier/config", why: "presentation configuration" },
  { target: "engine", path: "/health", why: "an internal signal" },
  { target: "engine", path: "/storage/x", why: "an opaque key-addressed store" },
  { target: "engine", path: "/docs", why: "the Protocol API's Swagger UI" },
  { target: "engine", path: "/", why: "version disclosure" },
  { target: "platform", path: "/v1/tenants", why: "tenant management" },
  { target: "platform", path: "/v1/presentations", why: "enumeration of transactions" },
  { target: "platform", path: "/health", why: "engine reachability" },
  { target: "platform", path: "/openapi", why: "the API's own description" },
];
