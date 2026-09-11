import type { IssuanceOutcome, IssuanceProgress, IssuanceStatus } from "@edtp/eudi-issuer-port";
import type { EngineSessionResponse } from "./schemas.js";

/**
 * Issuance outcome normalisation.
 *
 * The same rule as the verification side, for the same reason: **never branch on the engine's
 * coarse session status.** `failed` covers trust, signature, protocol and eligibility failures
 * alike and is not decidable, so the adapter branches on the machine-readable failure code and
 * degrades visibly when it meets one it does not know.
 *
 * What differs from verification is the meaning of the intermediate states. An issuance session
 * goes `active` → (wallet collects the offer) → `fetched` → `completed`, so `fetched` means the
 * Wallet has begun but no attestation exists yet. Mapping it to `SETTLED` would report an issuance
 * that has not happened.
 */

/**
 * Failure codes that mean the provider side could not do its job, rather than anything the Wallet
 * or User did.
 *
 * Reported separately because the platform must not tell a customer "the wallet refused" when in
 * fact the platform's own signing key or trust list was unavailable. The same distinction the
 * verification side draws for `trust_list_unavailable`.
 */
const PROVIDER_SIDE_CODES: readonly string[] = [
  "trust_list_unavailable",
  "signing_key_unavailable",
  "status_list_unavailable",
  "attribute_provider_unavailable",
];

/** Codes that mean trust could not be established in either direction. */
const TRUST_CODES: readonly string[] = [
  "no_trust_chain_to_root",
  "trust_chain_not_trusted",
  "trust_list_unavailable",
  "certificate_expired",
  "x5c_missing",
  "wallet_attestation_invalid",
  "key_attestation_invalid",
];

/** OpenID4VCI / OAuth denial, the only signal that means the User actually refused. */
const DENIAL_CODES: readonly string[] = ["access_denied"];

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Maps an engine session to a platform issuance status.
 *
 * Unknown statuses and unknown failure codes both degrade safely and **visibly**: an unrecognised
 * status is treated as still in progress rather than as a settled success, and an unrecognised
 * failure code becomes `PROTOCOL_ERROR` with the raw code retained for diagnosis. Given the
 * engine's release cadence — six releases in 27 days at the time of Phase 0 — that is the
 * difference between a new code being noticed and being misclassified as success.
 */
export const normaliseIssuanceOutcome = (session: EngineSessionResponse): IssuanceStatus => {
  const failureCode = asString(session.failureCode) ?? asString(session.outcome?.error);
  const failureMessage = asString(session.outcome?.message) ?? asString(session.errorReason);
  const statusList = readStatusListPlacement(session);

  const progressOnly = (progress: IssuanceProgress): IssuanceStatus => ({
    progress,
    ...statusList,
  });

  const settled = (outcome: IssuanceOutcome): IssuanceStatus => ({
    progress: "SETTLED",
    outcome,
    ...(failureCode ? { failureCode } : {}),
    ...(failureMessage ? { failureMessage } : {}),
    ...(failureCode && PROVIDER_SIDE_CODES.includes(failureCode)
      ? { providerSideFailure: true }
      : {}),
    ...statusList,
  });

  switch (session.status) {
    case "completed":
      // A completed session with a failure code is not a success, whatever the status says.
      if (failureCode) return settled(classifyFailure(failureCode));
      return settled("ISSUED");

    case "expired":
      return settled("EXPIRED");

    case "failed":
      // The undecidable case. Branch on the code, never on the status.
      return settled(failureCode ? classifyFailure(failureCode) : "PROTOCOL_ERROR");

    case "fetched":
      // The Wallet has collected the offer and is exchanging tokens. No attestation yet.
      return progressOnly("ISSUING");

    case "active":
      return progressOnly("AWAITING_WALLET");

    default:
      // An unrecognised status. Degrade to "still waiting" rather than inventing an outcome; the
      // platform's own transaction lifetime will expire it if it never settles.
      return progressOnly("AWAITING_WALLET");
  }
};

const classifyFailure = (code: string): IssuanceOutcome => {
  if (DENIAL_CODES.includes(code)) return "DECLINED_BY_USER";
  if (TRUST_CODES.includes(code)) return "TRUST_ERROR";
  return "PROTOCOL_ERROR";
};

/**
 * Reads the status-list placement the engine recorded, if any.
 *
 * Tolerant of shape because this is the one piece of issuance metadata the platform must keep to
 * be able to revoke later, and losing it to a renamed field would make revocation impossible. Both
 * the nested and flattened spellings the engine has used are accepted.
 */
const readStatusListPlacement = (
  session: EngineSessionResponse,
): { statusListUri?: string; statusListIndex?: number } => {
  const record = session as unknown as Record<string, unknown>;
  const nested = record.statusList;
  const container =
    nested && typeof nested === "object" ? (nested as Record<string, unknown>) : record;

  const uri =
    asString(container.uri) ??
    asString(container.statusListUri) ??
    asString(record.statusListUri);
  const rawIndex = container.index ?? container.idx ?? record.statusListIndex;
  const index =
    typeof rawIndex === "number" && Number.isInteger(rawIndex) ? rawIndex : undefined;

  return {
    ...(uri ? { statusListUri: uri } : {}),
    ...(index !== undefined ? { statusListIndex: index } : {}),
  };
};
