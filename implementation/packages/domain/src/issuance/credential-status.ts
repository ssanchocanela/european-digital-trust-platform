import { PlatformError } from "@edtp/shared";

/**
 * Attestation status, and the one rule the platform must enforce that the engine does not.
 *
 * ## `VCR_04` — revocation is not reversible
 *
 * `AS-AP-07-007` (`VCR_04`): a provider that has revoked an attestation **"SHALL NOT reverse the
 * revocation"**. Phase 0 established that the wrapped engine accepts `status: 0` after
 * `status: 1` — it will happily un-revoke — so this is a rule the **platform** owns. The engine
 * cannot be relied on for it, and a reviewer's vigilance is not a control.
 *
 * Suspension is different and must stay different: a suspended attestation may be reinstated,
 * which is the whole point of having suspension as a separate state. Collapsing the two — either by
 * forbidding reinstatement, or by allowing un-revocation — loses a distinction the Regulation draws.
 *
 * So the machine is deliberately asymmetric:
 *
 * ```
 *   VALID    → SUSPENDED, REVOKED
 *   SUSPENDED → VALID, REVOKED          (reinstatement allowed)
 *   REVOKED  →                          (terminal, always)
 * ```
 */
export const CREDENTIAL_STATUSES = ["VALID", "SUSPENDED", "REVOKED"] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

const STATUS_TRANSITIONS: Readonly<Record<CredentialStatus, readonly CredentialStatus[]>> = {
  VALID: ["SUSPENDED", "REVOKED"],
  SUSPENDED: ["VALID", "REVOKED"],
  // Terminal by regulation, not by convenience.
  REVOKED: [],
};

export const canTransitionStatus = (from: CredentialStatus, to: CredentialStatus): boolean =>
  STATUS_TRANSITIONS[from].includes(to);

/**
 * Refuses an illegal status change, with the reason in the message.
 *
 * Un-revocation gets its own error code and its own explanation, because it is the one case where
 * a caller may reasonably believe the operation should work — the engine would accept it — and
 * needs to be told why the platform does not.
 */
export const assertStatusTransition = (
  from: CredentialStatus,
  to: CredentialStatus,
  options: { readonly suspensionAllowed: boolean } = { suspensionAllowed: true },
): void => {
  if (from === "REVOKED" && to !== "REVOKED") {
    throw PlatformError.conflict(
      "revocation_is_irreversible",
      "A revoked attestation cannot be reinstated. `AS-AP-07-007` (`VCR_04`) states that a " +
        "provider that has revoked an attestation shall not reverse the revocation. The wrapped " +
        "engine would accept this call, so the platform refuses it: issue a new attestation " +
        "instead. Suspension, which is reversible, is the mechanism for a temporary hold.",
    );
  }

  if (to === "SUSPENDED" && !options.suspensionAllowed) {
    throw PlatformError.conflict(
      "suspension_not_permitted",
      "The issuance policy for this attestation does not permit suspension.",
    );
  }

  if (from === to) {
    throw PlatformError.conflict("status_unchanged", `The attestation is already ${from}.`);
  }

  if (!canTransitionStatus(from, to)) {
    throw PlatformError.conflict(
      "illegal_status_transition",
      `An attestation's status cannot move from ${from} to ${to}.`,
    );
  }
};

/**
 * An issued attestation, as the platform records it.
 *
 * **Metadata only.** No attribute values, no credential, no SD-JWT. What is kept is what is needed
 * to answer "was something issued, under which policy, and is it still valid" — and to revoke it.
 *
 * `engineSessionRef` is the awkward but necessary field. The engine exposes status mutation only as
 * a session-keyed call, and its status-mapping table has no foreign key to the session, so
 * revocation survives a session purge — *but only if the platform kept the reference*. It is
 * internal metadata: never returned to a customer, never logged. It is on the log-redaction
 * deny-list because the revocation index is an `ISSU_35` unique element.
 */
export interface IssuedCredentialRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly issuanceTransactionId: string;
  readonly credentialTypeId: string;
  readonly issuancePolicyId: string;
  readonly issuancePolicyVersion: number;
  readonly status: CredentialStatus;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /** Internal only. See the note above. */
  readonly engineSessionRef: string;
  /** Status list reference and index, when the type has a status mechanism. */
  readonly statusListUri?: string;
  readonly statusListIndex?: number;
  readonly statusChangedAt?: Date;
}

/** True when the attestation has passed its own validity, regardless of status. */
export const isCredentialExpired = (record: IssuedCredentialRecord, at: Date): boolean =>
  record.expiresAt.getTime() <= at.getTime();

/**
 * Whether the attestation should be treated as usable.
 *
 * Expiry is checked before status deliberately: an expired attestation is not "valid but old", and
 * reporting it as `VALID` because nobody revoked it would be misleading.
 */
export const isCredentialUsable = (record: IssuedCredentialRecord, at: Date): boolean =>
  record.status === "VALID" && !isCredentialExpired(record, at);
