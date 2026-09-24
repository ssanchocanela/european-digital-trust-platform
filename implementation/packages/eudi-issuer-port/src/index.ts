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
  /**
   * True when the signed metadata's protected header carries an `x5c` chain — the provider's access
   * certificate, which ETSI TS 119 472-3 V1.1.1 `ISS-MDATA-4.2.1-02` requires to be the signing
   * certificate and `ISS-MDATA-ACC_CERT-4.2.2-01/-02` require in the header.
   *
   * Necessarily false when there is no signed metadata, because the header is the **only** conformant
   * place for this certificate: there is no separate metadata field for it. That is why gate (a) has
   * one fix and not two.
   */
  readonly accessCertificateInSignedMetadata: boolean;
  /**
   * True when `issuer_info` is at the top level of the **signed** payload, per
   * `ISS-MDATA-REG_CERT-4.2.3-02` — not merely present in the unsigned document, which is where the
   * engine puts it today.
   */
  readonly registrationCertificateInSignedPayload: boolean;
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
   *
   * ## Why the policy identity is part of the input
   *
   * It names *which* credential configuration the transition applies to, and the wrapped engine
   * needs it. Its status-update contract marks that field optional — "if omitted, all credentials
   * linked to the session are updated" — and **the omitted path is the broken one**: the engine
   * throws a `TypeORMError` about an undefined value in a `where` condition and answers `500`.
   * Measured on one session, one status, two calls: without the field `500`, with it `204`.
   * `docs/interop-findings.md` A26.
   *
   * These are platform concepts — a policy and its version. The engine's identifier format is the
   * adapter's business and is derived there, so this port stays free of engine identifiers.
   */
  updateCredentialStatus(input: {
    readonly session: CredentialOfferHandle;
    readonly status: CredentialStatus;
    readonly policyId: string;
    readonly policyVersion: number;
  }): Promise<void>;

  cancelIssuance(session: CredentialOfferHandle): Promise<void>;

  /**
   * The opaque authorization-request reference a wallet-initiated session was created for.
   *
   * In an issuance the wallet starts from its own list of issuers there is no offer: the wallet
   * pushes an authorization request, receives an opaque reference, and is sent to the platform's
   * hosted form with it. When the protocol engine later asks the platform for claim values it names
   * only its session, and this is how the two are joined. `undefined` when the session carries no
   * such reference.
   */
  resolveAuthorizationRequest(session: CredentialOfferHandle): Promise<string | undefined>;

  /**
   * The other direction: which policy version a wallet's pending authorization request asks for.
   *
   * A wallet that lists several credentials from one issuer tells the issuer which it wants only in
   * the pushed authorization request. A hosted form sees the request's opaque reference and must know
   * what to offer. `undefined` when no pending request carries that reference.
   */
  findWalletAuthorizationRequest(input: {
    readonly engineTenantRef: string;
    readonly requestUri: string;
  }): Promise<
    | {
        readonly requested: readonly {
          readonly policyId: string;
          readonly policyVersion: number;
        }[];
      }
    | undefined
  >;
}

/** Provisioning, separated so the business layer never touches it. */
export interface EudiIssuerProvisioningPort {
  /**
   * Creates or replaces the engine-side issuance configuration and credential configuration.
   *
   * Idempotent by identifier, so re-provisioning an Attestation Provider is safe.
   */
  provisionCredentialConfiguration(input: IssuanceProvisioningInput): Promise<void>;

  /**
   * Removes the engine configurations of the given versions of a policy, so a wallet reading the
   * issuer's metadata discovers only the current one. Versions that were never provisioned are
   * skipped. Attestations already issued under them keep their status entries.
   */
  withdrawCredentialConfigurations(input: {
    readonly engineTenantRef: string;
    readonly policyId: string;
    readonly versions: readonly number[];
  }): Promise<void>;

  /** Imports the attestation-signing key and its certificate chain. Returns an opaque reference. */
  importSigningCertificate(input: {
    readonly engineTenantRef: string;
    readonly name: string;
    readonly privateKeyJwk: Readonly<Record<string, unknown>>;
    readonly certificateChain: readonly string[];
  }): Promise<{ readonly keyBindingRef: string }>;

  /**
   * Imports the provider's **own** access certificate, for the §7.3 eligibility presentation.
   *
   * Separate from `importSigningCertificate` because the two keys are not interchangeable: the
   * engine keys trust decisions off the usage type, and an attestation-signing key used to sign a
   * presentation request would be the wrong key in the wrong role. In that exchange the issuer is
   * the Relying Party — `interop-findings.md` A22.
   */
  importAccessCertificate(input: {
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
