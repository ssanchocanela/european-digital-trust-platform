import type {
  IntendedUseId,
  LocalisedText,
  PresentationPolicyId,
  PresentationPolicyVersionId,
  RelyingPartyServiceId,
  TenantId,
} from "@edtp/shared";
import type { RetentionPolicy, TrustPolicy } from "../kernel/policies.js";
import type { PolicyContainerStatus, PolicyStatus } from "../kernel/policy-version.js";
import type { CredentialFormat } from "../kernel/registration.js";
import type { RequestedClaim } from "./claim-path.js";
import type { ResultPolicy } from "./result-policy.js";

/**
 * A Presentation Policy is a versioned, business-oriented definition of the evidence
 * a Relying Party Service requires from an EUDI Wallet for **one registered intended
 * use**, the conditions under which that evidence is accepted, the minimum
 * information requested, and the result exposed to the consuming service.
 */
export interface PresentationPolicy {
  readonly id: PresentationPolicyId;
  readonly tenantId: TenantId;
  readonly relyingPartyServiceId: RelyingPartyServiceId;
  readonly intendedUseId: IntendedUseId;
  readonly name: string;
  readonly description: string;
  readonly status: PolicyContainerStatus;
  readonly createdAt: Date;
}

/**
 * The credential a policy version requires.
 *
 * V0 constraint: **one credential requirement per policy.** It is modelled as a list
 * with one element so multi-attestation intended uses — which TS5 permits, since
 * `IntendedUse.credentials` is `[1..*]` — can be added later without a migration.
 */
export interface CredentialRequirement {
  /**
   * The platform-facing credential type. For `dc+sd-jwt` this is the `vct`; for
   * `mso_mdoc` the document type. Kept as one field because a policy names one
   * credential type and lists the formats it will accept for it.
   */
  readonly credentialType: string;
  readonly acceptedFormats: readonly CredentialFormat[];
}

export interface PresentationPolicyVersion {
  readonly id: PresentationPolicyVersionId;
  readonly policyId: PresentationPolicyId;
  readonly tenantId: TenantId;
  readonly version: number;
  /**
   * Localised purpose, shown to the User by the Wallet — `AS-WP-06-015` (`RPA_10`).
   * TS5 models `IntendedUse.purpose` as `[1..*]` of MultiLangString.
   */
  readonly purpose: readonly LocalisedText[];
  /**
   * One element in V0. See `CredentialRequirement`.
   */
  readonly credentialRequirements: readonly CredentialRequirement[];
  readonly requestedClaims: readonly RequestedClaim[];
  readonly trustPolicy: TrustPolicy;
  readonly resultPolicy: ResultPolicy;
  readonly retentionPolicy: RetentionPolicy;
  readonly status: PolicyStatus;
  readonly createdAt: Date;
  readonly publishedAt?: Date;
  readonly retiredAt?: Date;
}

/** The single credential requirement of a V0 policy version. */
export const soleCredentialRequirement = (
  version: PresentationPolicyVersion,
): CredentialRequirement => {
  const first = version.credentialRequirements[0];
  if (!first || version.credentialRequirements.length !== 1) {
    throw new Error(
      "V0 supports exactly one credential requirement per presentation policy version.",
    );
  }
  return first;
};
