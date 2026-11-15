/**
 * Testing wallets (ADR 0022): what the server can say about a step, and the words a report may never
 * use. Pure.
 */

/**
 * What the sandbox itself observed in a step, derived from the platform's own transaction state —
 * never the engine's status (CLAUDE.md §6.5). Kept apart from the tester's observation.
 *
 * - `presented`: a presentation arrived: the wallet released data, whatever the platform then did
 *   with it. The one outcome the server sees without doubt.
 * - `credential_collected`: the wallet fetched the credential. Whether it then stored or discarded it
 *   happens in the wallet, and only the tester can say.
 * - `wallet_declined`: an explicit refusal from the wallet, e.g. `access_denied`. Best-effort (§6.6).
 * - `issuer_refused_wallet`: on issuance, the issuer did not trust the wallet (its attestation).
 * - `no_presentation` / `no_collection`: nothing arrived before the step expired. **Not** "refused":
 *   the wallet may have refused, failed, or never been used.
 * - `protocol_error`: the exchange broke; the server cannot say on which side.
 * - `pending`: still waiting.
 */
export type ServerObservation =
  | "presented"
  | "credential_collected"
  | "wallet_declined"
  | "issuer_refused_wallet"
  | "no_presentation"
  | "no_collection"
  | "protocol_error"
  | "pending";

export function presentationObservation(status: string): ServerObservation {
  switch (status) {
    case "PRESENTATION_RECEIVED":
    case "VERIFYING":
    case "VERIFIED":
    case "REJECTED":
    case "POLICY_NOT_SATISFIED":
    // The engine refused what the wallet sent — so the wallet sent it.
    case "TRUST_ERROR":
      return "presented";
    case "DECLINED_BY_USER":
      return "wallet_declined";
    case "EXPIRED":
    case "CANCELLED":
      return "no_presentation";
    case "PROTOCOL_ERROR":
      return "protocol_error";
    default:
      return "pending";
  }
}

export function issuanceObservation(status: string): ServerObservation {
  switch (status) {
    case "ISSUED":
      return "credential_collected";
    case "DECLINED_BY_USER":
      return "wallet_declined";
    case "TRUST_ERROR":
      return "issuer_refused_wallet";
    case "EXPIRED":
    case "CANCELLED":
      return "no_collection";
    case "PROTOCOL_ERROR":
    case "NOT_ELIGIBLE":
      return "protocol_error";
    default:
      return "pending";
  }
}

/** The sentence every wallet-test page and export carries (ADR 0022 §1). */
export const NOT_A_CONFORMANCE_TEST = "This is not a conformance test and certifies nothing.";

/** Words a wallet-test page or export must never contain (ADR 0022 §1). */
export const BANNED_REPORT_WORDS = [
  "pass",
  "passed",
  "fail",
  "failed",
  "conformant",
  "compliant",
  "certified",
] as const;

/**
 * The banned words found in a text, as whole words, case-insensitive. The fixed disclaimer is removed
 * first: "certifies nothing" is the one place the root may appear.
 */
export function bannedWordsIn(text: string): string[] {
  const body = text.split(NOT_A_CONFORMANCE_TEST).join(" ");
  return BANNED_REPORT_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(body));
}
