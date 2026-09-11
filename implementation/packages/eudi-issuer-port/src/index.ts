import type { CredentialStatus, IssuancePlan, SourceAttributes } from "@edtp/domain";
import type { EngineSessionRef } from "@edtp/shared";

/**
 * The issuer port.
 *
 * Platform types only. No engine type, identifier, configuration object or error crosses this
 * boundary — the same rule ADR 0002 Decision 2 sets for the verifier port. An implementation of
 * this interface is the only code permitted to know that a protocol engine exists.
 *
 * Two Phase 0 findings constrain the implementation and are recorded here so they are not
 * rediscovered:
 *
 * - **Revocation must not be reversible.** `AS-AP-07-007` (`VCR_04`). The engine accepts a
 *   transition back to valid, so the platform refuses un-revocation while still permitting
 *   reinstatement from *suspended*. Enforced in the domain (`credential-status.ts`), never here.
 * - **The engine's status call is session-keyed**, and its status-mapping table has no foreign key
 *   to the session, so revocation survives session purge — but only if the platform retained the
 *   engine session reference. `IssuedCredentialRecord` keeps it as internal metadata.
 */

export interface IssuanceProvisioningInput {
  readonly engineTenantRef: string;
  /** The plan, which carries the credential definition and the provider context. */
  readonly plan: IssuancePlan;
}

export interface CreateCredentialOfferInput {
  readonly plan: IssuancePlan;
  /**
   * Attribute values fetched just in time from the authentic source.
   *
   * **This is content.** It is passed to the engine and never persisted by the platform — only
   * issuance metadata and the status reference remain (ADR 0004, and §7.5 of the V0 plan).
   */
  readonly claims: SourceAttributes;
  readonly sessionTtlSeconds: number;
  /** Where the wallet returns the user after a same-device flow, when applicable. */
  readonly returnUrl?: string;
}

export interface CredentialOfferHandle {
  readonly ref: EngineSessionRef;
  readonly engineTenantRef: string;
}

export interface CreateCredentialOfferOutput {
  readonly session: CredentialOfferHandle;
  /** The credential-offer URI, passed through as an **opaque** value. */
  readonly uri: string;
  /**
   * True when the offer was made without a registration certificate in the Credential Issuer
   * metadata.
   *
   * Trust gate (a), ARF §6.6.2.2: a Wallet authenticates the Attestation Provider *before*
   * requesting a credential, from the certificates in that metadata. V0 holds none (blocker B3),
   * so the adapter reports the omission. It is never fabricated and never silently ignored.
   */
  readonly sentWithoutRegistrationCertificate: boolean;
}

/** Where the engine is in the issuance flow, in platform terms. */
export const ISSUANCE_PROGRESS = ["AWAITING_WALLET", "ISSUING", "SETTLED"] as const;
export type IssuanceProgress = (typeof ISSUANCE_PROGRESS)[number];

export const ISSUANCE_OUTCOMES = [
  "ISSUED",
  "DECLINED_BY_USER",
  "TRUST_ERROR",
  "PROTOCOL_ERROR",
  "EXPIRED",
  "CANCELLED",
] as const;
export type IssuanceOutcome = (typeof ISSUANCE_OUTCOMES)[number];

export interface IssuanceStatus {
  readonly progress: IssuanceProgress;
  /** Present when `progress` is `SETTLED`. Derived from the engine's failure taxonomy. */
  readonly outcome?: IssuanceOutcome;
  readonly failureCode?: string;
  /** Short, safe message. Carries no attribute values, certificate subjects or list URLs. */
  readonly failureMessage?: string;
  /**
   * True when the failure is a provider-side condition — a trust list that could not be loaded,
   * a signing key unavailable — rather than anything the Wallet or User did.
   */
  readonly providerSideFailure?: boolean;
  /**
   * Status list placement of the issued attestation, when the type has a status mechanism.
   *
   * Metadata, not content: the reference and index are what make later revocation possible. The
   * index is an `ISSU_35` unique element, so it is never returned to a customer.
   */
  readonly statusListUri?: string;
  readonly statusListIndex?: number;
}

/**
 * What the Wallet would see when it authenticates the provider — trust gate (a).
 *
 * Exposed on the port so the platform can assert on it without the business layer learning what
 * OpenID4VCI is. The adapter fetches the Credential Issuer metadata and reports only these
 * platform-level facts.
 */
export interface ProviderAuthenticationEvidence {
  /** The credential issuer identifier the metadata declares. */
  readonly credentialIssuer: string;
  /** True when the metadata carries a registration certificate (`issuer_info`). */
  readonly registrationCertificatePresent: boolean;
  /** The registration certificate, when present, so a caller can verify it. */
  readonly registrationCertificateJwt?: string;
  /**
   * True when the metadata document itself is signed, so a Wallet can authenticate it.
   *
   * The pinned Reference Wallet requires this (`requireSignedMetadata()` →
   * `IssuerMetadataPolicy.RequireSigned`). Reported rather than assumed, because the engine at the
   * pinned version does not produce it — see `docs/issuer-trust-model.md` gate (a).
   */
  readonly metadataSigned: boolean;
  /** The credential configuration identifiers the metadata advertises. */
  readonly credentialConfigurationIds: readonly string[];
}

export interface EudiIssuerPort {
  createCredentialOffer(
    input: CreateCredentialOfferInput,
  ): Promise<CreateCredentialOfferOutput>;

  getIssuanceStatus(session: CredentialOfferHandle): Promise<IssuanceStatus>;

  /**
   * Updates the status of the attestation issued in one transaction.
   *
   * The platform, not the engine, enforces that `REVOKED` is terminal. This method simply carries
   * out a transition the domain has already approved.
   */
  updateCredentialStatus(input: {
    readonly session: CredentialOfferHandle;
    readonly status: CredentialStatus;
  }): Promise<void>;

  cancelIssuance(session: CredentialOfferHandle): Promise<void>;
}

/** Provisioning, separated so the business layer never touches it. */
export interface EudiIssuerProvisioningPort {
  /**
   * Creates or replaces the engine-side issuance configuration and credential configuration.
   *
   * Idempotent by identifier, so re-provisioning an Attestation Provider is safe.
   */
  provisionCredentialConfiguration(input: IssuanceProvisioningInput): Promise<void>;

  /** Imports the attestation-signing key and its certificate chain. Returns an opaque reference. */
  importSigningCertificate(input: {
    readonly engineTenantRef: string;
    readonly name: string;
    readonly privateKeyJwk: Readonly<Record<string, unknown>>;
    readonly certificateChain: readonly string[];
  }): Promise<{ readonly keyBindingRef: string }>;

  /** Fetches the provider-authentication evidence a Wallet would see. Trust gate (a). */
  fetchProviderAuthenticationEvidence(
    engineTenantRef: string,
  ): Promise<ProviderAuthenticationEvidence>;

  healthy(): Promise<boolean>;
}
