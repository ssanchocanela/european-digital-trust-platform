/**
 * Trust and retention policy types.
 *
 * **Interfaces and types only in V0 — there is no policy engine.** These shape the
 * `VerificationPlan` and record the intent, and the engine enforces the trust
 * constraints. ADR 0002 records that V0 may delegate trust validation to the engine.
 */

/**
 * Where trust anchors may come from.
 *
 * `EW-PIO-01-029` (`OIA_15b`) requires Relying Parties and Relying Party Instances to
 * support **both** Trusted Lists complying with ETSI TS 119 612 and Lists of Trusted
 * Entities complying with ETSI TS 119 602, so the model must allow both from the
 * start even though V0 delegates the resolution.
 */
export const TRUST_ANCHOR_SOURCE_KINDS = [
  "ETSI_TS_119_602_LOTE",
  "ETSI_TS_119_612_TRUSTED_LIST",
] as const;
export type TrustAnchorSourceKind = (typeof TRUST_ANCHOR_SOURCE_KINDS)[number];

/**
 * Which ARF trust domain an anchor source serves.
 *
 * These are kept separate deliberately. The EUDI development environment publishes
 * byte-identical trust anchors for PID Providers, access-certificate providers and
 * registration-certificate providers (`docs/interop-findings.md` C1), but ARF keeps
 * the domains distinct — `EW-PIO-01-024` (`OIA_12`) for PID Provider anchors,
 * `AS-WP-06-005` (`RPA_04`) for Access CA anchors, `EW-DM-44-005` (`RPRC_02a`) for
 * registration-certificate provider anchors. The platform must never infer one from
 * another, even where the environment would let it.
 */
export const TRUST_DOMAINS = [
  "PID_PROVIDER",
  "QEAA_PROVIDER",
  "PUB_EAA_PROVIDER",
  "EAA_PROVIDER",
  "ACCESS_CERTIFICATE_PROVIDER",
  "REGISTRATION_CERTIFICATE_PROVIDER",
] as const;
export type TrustDomain = (typeof TRUST_DOMAINS)[number];

export interface TrustAnchorSource {
  readonly kind: TrustAnchorSourceKind;
  readonly domain: TrustDomain;
  /** Opaque reference resolved by the adapter; the domain does not fetch anything. */
  readonly ref: string;
}

/**
 * How credential status is checked.
 *
 * `AS-AP-07-023` (`VCR_13`) makes revocation checking a `SHOULD` whose omission
 * requires a documented risk analysis. V0 has performed no such analysis, so it uses
 * `STRICT` — fail-closed. `AS-AP-07-021` (`VCR_12`) additionally requires a Relying
 * Party that checks revocation to support both the Attestation Status List and the
 * Attestation Revocation List mechanisms of `AS-AP-07-019` (`VCR_11`); V0 issues and
 * verifies SD-JWT VC, covered by `AS-AP-07-020` (`VCR_11a`), and makes no claim for
 * mdoc (open question Q4).
 */
export const STATUS_CHECK_MODES = ["STRICT", "BEST_EFFORT", "DISABLED"] as const;
export type StatusCheckMode = (typeof STATUS_CHECK_MODES)[number];

export interface TrustPolicy {
  readonly anchorSources: readonly TrustAnchorSource[];
  readonly statusCheckMode: StatusCheckMode;
}

export const defaultTrustPolicy = (): TrustPolicy => ({
  anchorSources: [],
  statusCheckMode: "STRICT",
});

/**
 * Retention intent for one transaction.
 *
 * The platform never persists content, so there is nothing to retain; these values
 * size the transaction lifetime and the engine session window. ADR 0004 requires the
 * engine session TTL to be sized to the transaction lifetime rather than to an audit
 * window.
 */
export interface RetentionPolicy {
  /** How long the wallet has to respond before the transaction expires. */
  readonly transactionLifetimeSeconds: number;
  /** How long a normalised result remains readable via the API. */
  readonly resultRetentionSeconds: number;
}

export const DEFAULT_TRANSACTION_LIFETIME_SECONDS = 300;
export const DEFAULT_RESULT_RETENTION_SECONDS = 86_400;

/** The engine enforces a minimum session TTL of 60 seconds. */
export const ENGINE_MIN_SESSION_TTL_SECONDS = 60;

export const defaultRetentionPolicy = (): RetentionPolicy => ({
  transactionLifetimeSeconds: DEFAULT_TRANSACTION_LIFETIME_SECONDS,
  resultRetentionSeconds: DEFAULT_RESULT_RETENTION_SECONDS,
});
