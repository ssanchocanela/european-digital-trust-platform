import type { TrustAnchorSource, TrustDomain } from "../kernel/policies.js";

/**
 * Normalised trust resolution.
 *
 * The result is never a single boolean. `EW-PIO-01-029` (`OIA_15b`) requires a Relying
 * Party to support both ETSI TS 119 612 Trusted Lists and ETSI TS 119 602 LoTEs, and
 * the existing knowledge base requires structured reasons and freshness rather than a
 * `trusted=true` flag. `UNKNOWN` and `ERROR` are kept distinct because they call for
 * different operator action: `UNKNOWN` means the entity is not in a list we hold,
 * `ERROR` means we could not evaluate the question at all.
 */
export const TRUST_OUTCOMES = ["TRUSTED", "UNTRUSTED", "UNKNOWN", "ERROR"] as const;
export type TrustOutcome = (typeof TRUST_OUTCOMES)[number];

export interface TrustResolution {
  readonly outcome: TrustOutcome;
  /** Which ARF trust domain the question was asked in. Never inferred across domains. */
  readonly domain: TrustDomain;
  /** Stable machine-readable reason. Safe to expose; carries no certificate detail. */
  readonly reason: string;
  /** Human-readable, short and safe for display. */
  readonly message: string;
  /** When the underlying trust source was last refreshed, where the engine reports it. */
  readonly evaluatedAt: Date;
}

/**
 * V0 delegates trust validation to the wrapped engine, which normalises ETSI
 * TS 119 602 LoTEs and ETSI TS 119 612 Trusted Lists into one trust store at its load
 * boundary. The platform owns the interface so the delegation can be withdrawn.
 *
 * Note what delegation does **not** cover: `EW-PIO-01-028` (`OIA_15a`) obliges a
 * Relying Party to download the latest lists and to propagate added anchors to, and
 * remove invalidated anchors from, all its Relying Party Instances. That is a
 * platform-owned responsibility and is out of V0 scope — recorded in
 * `docs/interop-findings.md` B3 and `docs/security-limitations.md`.
 */
export interface TrustResolver {
  resolveAttestationTrust(
    sources: readonly TrustAnchorSource[],
    domain: TrustDomain,
  ): Promise<TrustResolution>;
}

export const trusted = (domain: TrustDomain, at: Date): TrustResolution => ({
  outcome: "TRUSTED",
  domain,
  reason: "trust_anchor_matched",
  message: "The issuer chains to a configured trust anchor.",
  evaluatedAt: at,
});

export const trustError = (
  domain: TrustDomain,
  reason: string,
  message: string,
  at: Date,
): TrustResolution => ({ outcome: "ERROR", domain, reason, message, evaluatedAt: at });
