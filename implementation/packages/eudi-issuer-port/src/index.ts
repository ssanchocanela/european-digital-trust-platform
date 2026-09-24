import type { EngineSessionRef } from "@edtp/shared";

/**
 * The issuer port — **interface only in Milestone 1.**
 *
 * Declared now so the shared kernel is shaped for issuance and so the boundary check
 * can already assert that nothing outside the adapter knows about a protocol engine.
 * No implementation exists until Milestone 2.
 *
 * Two findings from Phase 0 constrain the Milestone 2 implementation and are recorded
 * here so they are not rediscovered:
 *
 * - **Revocation must not be reversible.** `AS-AP-07-007` (`VCR_04`) states that a
 *   provider that revoked an attestation "SHALL NOT reverse the revocation". The
 *   engine accepts a transition back to valid, so the platform must refuse
 *   un-revocation while still permitting reinstatement from *suspended*.
 *   See `docs/interop-findings.md` B1.
 * - **The engine's revocation call is session-keyed**, and its status mapping table has
 *   no foreign key to the session, so revocation survives session purge — but only if
 *   the platform retained the engine session reference. `IssuedCredentialRecord` must
 *   therefore keep it as internal metadata while holding no attribute values.
 */

export const ISSUANCE_FLOWS = ["PRE_AUTHORIZED_CODE", "AUTHORIZATION_CODE"] as const;
export type IssuanceFlow = (typeof ISSUANCE_FLOWS)[number];

export const CREDENTIAL_STATUS_VALUES = ["VALID", "SUSPENDED", "REVOKED"] as const;
export type CredentialStatusValue = (typeof CREDENTIAL_STATUS_VALUES)[number];

export interface CreateCredentialOfferInput {
  readonly engineTenantRef: string;
  readonly credentialConfigurationRef: string;
  readonly flow: IssuanceFlow;
  /**
   * Attribute values fetched just in time from the authentic source.
   *
   * **This is content.** It is passed to the engine and never persisted by the
   * platform — only issuance metadata and the status reference remain.
   */
  readonly claims: Readonly<Record<string, unknown>>;
  readonly sessionTtlSeconds: number;
}

export interface CreateCredentialOfferOutput {
  readonly engineSessionRef: EngineSessionRef;
  /** The credential-offer URI, passed through as an opaque value. */
  readonly uri: string;
}

export interface EudiIssuerPort {
  createCredentialOffer(
    input: CreateCredentialOfferInput,
  ): Promise<CreateCredentialOfferOutput>;

  getIssuanceStatus(ref: EngineSessionRef): Promise<{ readonly settled: boolean }>;

  /**
   * Updates the status of the credentials issued in one transaction.
   *
   * The platform, not the engine, enforces that `REVOKED` is terminal.
   */
  updateCredentialStatus(input: {
    readonly engineTenantRef: string;
    readonly engineSessionRef: EngineSessionRef;
    readonly status: CredentialStatusValue;
  }): Promise<void>;

  cancelIssuance(ref: EngineSessionRef): Promise<void>;
}
