import type { LocalisedText } from "@edtp/shared";
import { PlatformError } from "@edtp/shared";
import type { RetentionPolicy } from "../kernel/policies.js";
import type { AttestationProvider, CredentialFormat } from "../kernel/registration.js";
import type { CredentialClaimDefinition, CredentialType } from "./credential-type.js";
import type {
  HolderBindingMode,
  IssuanceFlowKind,
  IssuancePolicyVersion,
} from "./issuance-policy.js";

/**
 * The immutable instruction set the issuer adapter executes.
 *
 * **No protocol structure appears here.** OpenID4VCI credential configurations, credential offers,
 * authorization-server selection, `issuer_info`, status-list encodings and engine configuration
 * objects are produced inside the adapter from this plan — the same boundary ADR 0002 Decision 2
 * draws for verification. The plan is what the domain knows; the protocol is what the adapter knows.
 */
export interface PlanAttestationProviderContext {
  /** Registrar-assigned identifier of the Attestation Provider. */
  readonly attestationProviderIdentifier: string;
  /**
   * The registration certificate to publish in the Credential Issuer metadata, by value.
   *
   * This is trust gate (a) — ARF §6.6.2.2 pre-issuance provider authentication. The Wallet
   * authenticates the provider *before* requesting a credential, from the certificates in the
   * Credential Issuer metadata. Absent in V0 (blocker B3), in which case the adapter reports the
   * omission and it is never fabricated.
   */
  readonly registrationCertificateJwt?: string;
  /** Opaque reference to the key chain holding the attestation-signing key. */
  readonly signingKeyBindingRef: string;
  /** Opaque reference to the engine tenant serving this Attestation Provider. */
  readonly engineTenantRef: string;
}

export interface PlanCredentialDefinition {
  readonly format: CredentialFormat;
  readonly vct?: string;
  readonly doctype?: string;
  readonly claims: readonly CredentialClaimDefinition[];
  readonly display: readonly LocalisedText[];
  /**
   * How a verifier obtains the anchors to check this attestation's signature — trust gate (b),
   * ARF §6.3.2.4. Carried into the plan because it decides what the adapter must put in the
   * attestation: an `x5c` chain, or an issuer identifier resolvable through a published list.
   */
  readonly anchorSource: "RULEBOOK_ONLY" | "RULEBOOK_AND_PUBLISHED_LIST";
  readonly rulebookIdentifier: string;
  readonly rulebookVersion: string;
}

export interface IssuancePlan {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly purpose: readonly LocalisedText[];
  readonly credential: PlanCredentialDefinition;
  readonly flow: IssuanceFlowKind;
  readonly holderBinding: HolderBindingMode;
  readonly credentialValiditySeconds: number;
  readonly statusListEnabled: boolean;
  readonly suspensionAllowed: boolean;
  readonly retentionInstructions: RetentionPolicy;
  readonly providerContext: PlanAttestationProviderContext;
  /** The claim paths to fetch from the authentic source. Exactly the declared ones. */
  readonly claimPathsToFetch: readonly string[];
  /** Set when the policy requires a PID presentation first (the §7.3 stretch goal). */
  readonly eligibilityPresentationPolicyId?: string;
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
};

export interface IssuanceCompilerInput {
  readonly policyVersion: IssuancePolicyVersion;
  readonly credentialType: CredentialType;
  readonly attestationProvider: AttestationProvider;
  readonly providerContext: PlanAttestationProviderContext;
  readonly at: Date;
}

/**
 * Compiles a published policy version into a plan.
 *
 * Re-validates rather than trusting that publication validated: a plan is built from records that
 * were written at different times, and the combination can be wrong even when each part was right
 * when stored — a credential type can be archived, a provider can belong to another tenant, a
 * registration certificate can expire. The verification-side compiler takes the same position, and
 * it is what caught three mismatches there.
 */
export const compileIssuancePolicy = (input: IssuanceCompilerInput): IssuancePlan => {
  const { policyVersion, credentialType, attestationProvider, providerContext } = input;

  if (policyVersion.status !== "PUBLISHED") {
    throw PlatformError.conflict(
      "policy_version_not_published",
      `Only a published issuance policy version can be compiled; this one is ${policyVersion.status}.`,
    );
  }

  if (policyVersion.credentialTypeId !== credentialType.id) {
    throw PlatformError.conflict(
      "credential_type_mismatch",
      "The policy version references a different credential type than the one supplied.",
    );
  }

  if (credentialType.attestationProviderId !== attestationProvider.id) {
    throw PlatformError.conflict(
      "credential_type_provider_mismatch",
      "The credential type belongs to a different Attestation Provider.",
    );
  }

  if (credentialType.tenantId !== attestationProvider.tenantId) {
    throw PlatformError.conflict(
      "tenant_mismatch",
      "The credential type and the Attestation Provider belong to different tenants.",
    );
  }

  // V0 supports TEST only, and a trust environment mismatch is exactly the kind of error that
  // would otherwise surface as an unexplained wallet refusal.
  if (attestationProvider.trustEnvironment !== "TEST") {
    throw PlatformError.conflict(
      "trust_environment_unsupported",
      "V0 operates in the TEST trust environment only.",
    );
  }

  const credential: PlanCredentialDefinition = {
    format: credentialType.format,
    ...(credentialType.vct ? { vct: credentialType.vct } : {}),
    ...(credentialType.doctype ? { doctype: credentialType.doctype } : {}),
    claims: credentialType.claims,
    display: credentialType.display,
    anchorSource: credentialType.rulebook.anchorSource,
    rulebookIdentifier: credentialType.rulebook.identifier,
    rulebookVersion: credentialType.rulebook.version,
  };

  const plan: IssuancePlan = {
    policyId: policyVersion.policyId,
    policyVersion: policyVersion.version,
    purpose: policyVersion.purpose,
    credential,
    flow: policyVersion.flow,
    holderBinding: policyVersion.holderBinding,
    credentialValiditySeconds: policyVersion.credentialValiditySeconds,
    statusListEnabled: policyVersion.statusPolicy.statusListEnabled,
    suspensionAllowed: policyVersion.statusPolicy.suspensionAllowed,
    retentionInstructions: policyVersion.retentionPolicy,
    providerContext,
    claimPathsToFetch: credentialType.claims.map((c) => c.path.join(".")),
    ...(policyVersion.eligibilityPresentationPolicyId
      ? { eligibilityPresentationPolicyId: policyVersion.eligibilityPresentationPolicyId }
      : {}),
  };

  // Deep-frozen, so nothing downstream can mutate a compiled plan and quietly change what was
  // issued relative to what the transaction recorded.
  return deepFreeze(plan);
};

/** True when the plan will send a request without a registration certificate (blocker B3). */
export const sentWithoutRegistrationCertificate = (plan: IssuancePlan): boolean =>
  plan.providerContext.registrationCertificateJwt === undefined;
