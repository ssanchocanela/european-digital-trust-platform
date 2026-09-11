import type { TerminalState } from "@edtp/domain";
import type { EngineProgress } from "@edtp/eudi-verifier-port";

/**
 * Engine outcome normalisation.
 *
 * The engine's coarse session status is `active | fetched | completed | expired | failed`.
 * **`failed` is not decidable**: it covers trust failures, signature failures and
 * protocol failures alike. So the adapter branches on the machine-readable failure code
 * the engine added in v7.5.0 alongside its persisted structured outcome, never on the
 * status — ADR 0002 Decision 4. Pinning an earlier engine release would have forced
 * outcome classification back onto the undecidable status.
 */

export const ENGINE_SESSION_STATUSES = [
  "active",
  "fetched",
  "completed",
  "expired",
  "failed",
] as const;
export type EngineSessionStatus = (typeof ENGINE_SESSION_STATUSES)[number];

/**
 * The engine's shared verification failure taxonomy. Stable codes, produced by its
 * shared chain validator, so the same code appears for mdoc and SD-JWT VC and whether
 * the trust source was an ETSI TS 119 602 LoTE or an ETSI TS 119 612 Trusted List.
 */
export const ENGINE_FAILURE_CODES = [
  "signature_invalid",
  "no_trust_chain_to_root",
  "trust_chain_not_trusted",
  "trust_list_unavailable",
  "certificate_expired",
  "x5c_missing",
  "verification_error",
] as const;
export type EngineFailureCode = (typeof ENGINE_FAILURE_CODES)[number];

/**
 * Codes that indicate a defect in the **presented credential**.
 *
 * These become `REJECTED`: the credential's signature did not validate, a certificate
 * in its chain was outside its validity window, or the policy required an `x5c` chain
 * the credential did not carry.
 */
const CREDENTIAL_DEFECT_CODES: readonly string[] = [
  "signature_invalid",
  "certificate_expired",
  "x5c_missing",
];

/**
 * Codes that indicate trust could not be established for the attestation.
 *
 * A chain was present but did not reach a configured anchor, or no path could be built
 * at all. These become `TRUST_ERROR` rather than `REJECTED`, because the credential may
 * be perfectly valid under a trust configuration we do not hold.
 */
const TRUST_CODES: readonly string[] = ["no_trust_chain_to_root", "trust_chain_not_trusted"];

/**
 * A **verifier-side** condition: our own trust list could not be loaded, parsed,
 * signature-verified, or is stale.
 *
 * The engine documents this as a misconfiguration or outage on the verifier side and
 * keeps it deliberately distinct from `trust_chain_not_trusted` so operators can tell
 * the two apart. The platform must not report it to the customer as a failed
 * credential — it is our operational failure.
 */
const VERIFIER_SIDE_CODES: readonly string[] = ["trust_list_unavailable"];

/**
 * OpenID4VP error codes a wallet may return.
 *
 * `access_denied` is the one that maps to a user decision. Note `AS-WP-06-017`
 * (`RPA_11`): when the User denies a presentation the Wallet must "behave towards the
 * Relying Party as if the attestation or PID did not exist", so a denial is not
 * reliably distinguishable from non-possession. `DECLINED_BY_USER` is therefore
 * reported only on an explicit `access_denied`, and its absence never implies consent.
 */
const WALLET_DENIAL_CODES: readonly string[] = ["access_denied"];

export interface EngineOutcomeSignals {
  readonly status: EngineSessionStatus | string;
  /** `session.failureCode` (v7.5.0+). */
  readonly failureCode?: string | null;
  /** `session.outcome.error`, the top-level code of the structured outcome. */
  readonly outcomeError?: string | null;
  /** `session.outcome.result`. */
  readonly outcomeResult?: "success" | "failed" | string | null;
  /** Short, safe message from `session.errorReason` or `outcome.message`. */
  readonly message?: string | null;
  /**
   * Whether the platform's own result policy was satisfied by the disclosed claims.
   * Supplied by the caller after the policy has run; the engine has no view of it.
   */
  readonly policySatisfied?: boolean;
}

export interface NormalisedOutcome {
  readonly progress: EngineProgress;
  readonly outcome?: TerminalState;
  readonly failureCode?: string;
  readonly failureMessage?: string;
  readonly verifierSideFailure?: boolean;
}

export const progressFor = (status: string): EngineProgress => {
  switch (status) {
    case "active":
      return "AWAITING_WALLET";
    case "fetched":
      // The wallet has fetched the request object but has not responded yet. Still
      // awaiting the wallet from the platform's point of view.
      return "AWAITING_WALLET";
    case "completed":
    case "expired":
    case "failed":
      return "SETTLED";
    default:
      return "AWAITING_WALLET";
  }
};

/**
 * Maps engine signals to a platform terminal outcome.
 *
 * Any code the adapter does not recognise degrades to `PROTOCOL_ERROR` with the raw
 * code retained, so a new engine failure code fails safely and visibly rather than
 * being silently misclassified as something more specific.
 */
export const normaliseOutcome = (signals: EngineOutcomeSignals): NormalisedOutcome => {
  const progress = progressFor(signals.status);
  if (progress !== "SETTLED") return { progress };

  const message = signals.message ?? undefined;
  const code = signals.failureCode ?? signals.outcomeError ?? undefined;

  if (signals.status === "expired") {
    return { progress, outcome: "EXPIRED", ...(message ? { failureMessage: message } : {}) };
  }

  if (signals.status === "completed" && signals.outcomeResult !== "failed" && !code) {
    // A valid presentation. Whether the policy is satisfied is the platform's own
    // question, and the caller answers it after applying the result policy.
    const outcome: TerminalState =
      signals.policySatisfied === false ? "POLICY_NOT_SATISFIED" : "VERIFIED";
    return { progress, outcome };
  }

  if (code && WALLET_DENIAL_CODES.includes(code)) {
    return {
      progress,
      outcome: "DECLINED_BY_USER",
      failureCode: code,
      ...(message ? { failureMessage: message } : {}),
    };
  }

  if (code && CREDENTIAL_DEFECT_CODES.includes(code)) {
    return {
      progress,
      outcome: "REJECTED",
      failureCode: code,
      ...(message ? { failureMessage: message } : {}),
    };
  }

  if (code && TRUST_CODES.includes(code)) {
    return {
      progress,
      outcome: "TRUST_ERROR",
      failureCode: code,
      ...(message ? { failureMessage: message } : {}),
    };
  }

  if (code && VERIFIER_SIDE_CODES.includes(code)) {
    return {
      progress,
      outcome: "TRUST_ERROR",
      failureCode: code,
      verifierSideFailure: true,
      ...(message ? { failureMessage: message } : {}),
    };
  }

  return {
    progress,
    outcome: "PROTOCOL_ERROR",
    ...(code ? { failureCode: code } : {}),
    ...(message ? { failureMessage: message } : {}),
  };
};

/** True when the code is one the adapter explicitly recognises. */
export const isKnownFailureCode = (code: string): boolean =>
  (ENGINE_FAILURE_CODES as readonly string[]).includes(code) ||
  WALLET_DENIAL_CODES.includes(code);
