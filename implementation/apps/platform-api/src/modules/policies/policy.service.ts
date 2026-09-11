import {
  dedupeRequestedClaims,
  defaultRetentionPolicy,
  defaultTrustPolicy,
  nextVersionNumber,
  type PresentationPolicy,
  type PresentationPolicyVersion,
  type RequestedClaim,
  type ResultPolicy,
  type RetentionPolicy,
  type TrustPolicy,
  validatePolicyVersion,
} from "@edtp/domain";
import type { PolicyRepository, RegistrationRepository } from "@edtp/persistence";
import type { LocalisedText } from "@edtp/shared";
import {
  type Clock,
  type IntendedUseId,
  newPresentationPolicyId,
  newPresentationPolicyVersionId,
  normaliseLocalisedText,
  PlatformError,
  type PresentationPolicyId,
  type RelyingPartyServiceId,
  type TenantId,
} from "@edtp/shared";
import type { AuditService } from "../audit/audit.service.js";

export interface CreatePolicyInput {
  readonly tenantId: TenantId;
  readonly relyingPartyServiceId: RelyingPartyServiceId;
  readonly intendedUseId: IntendedUseId;
  readonly name: string;
  readonly description: string;
}

export interface CreateVersionInput {
  readonly tenantId: TenantId;
  readonly policyId: PresentationPolicyId;
  readonly purpose: readonly LocalisedText[];
  readonly credentialRequirements: PresentationPolicyVersion["credentialRequirements"];
  readonly requestedClaims: readonly RequestedClaim[];
  readonly resultPolicy: ResultPolicy;
  readonly trustPolicy?: TrustPolicy;
  readonly retentionPolicy?: RetentionPolicy;
  /** Publish immediately. A draft is not usable by a transaction. */
  readonly publish?: boolean;
}

/**
 * Presentation policy management.
 *
 * The important behaviour is in {@link createVersion}: a version is validated against the
 * registered intended use **before** it is stored, and a violation is a 422 naming every
 * offending claim path.
 *
 * That check is the earliest of three complementary layers. The engine checks at
 * credential granularity against the registration certificate at request time, and
 * `EW-DM-44-027` (`RPRC_21`) makes the Wallet check at attribute granularity and warn the
 * User that the Relying Party "is requesting more information than it has registered".
 * Catching it here means no customer traffic and no User ever sees that warning.
 */
export class PolicyService {
  constructor(
    private readonly policies: PolicyRepository,
    private readonly registration: RegistrationRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async createPolicy(input: CreatePolicyInput): Promise<PresentationPolicy> {
    const service = await this.registration.findRelyingPartyService(
      input.tenantId,
      input.relyingPartyServiceId,
    );
    if (!service) throw PlatformError.notFound("Relying Party Service");

    const intendedUse = await this.registration.findIntendedUse(
      input.tenantId,
      input.intendedUseId,
    );
    if (!intendedUse) throw PlatformError.notFound("Intended use");
    if (intendedUse.relyingPartyServiceId !== input.relyingPartyServiceId) {
      // `AS-MS-27-016` (`Reg_10d`): intended uses are registered per Service. A policy may
      // not borrow another Service's intended use.
      throw PlatformError.unprocessable(
        "intended_use_service_mismatch",
        "The intended use is not registered for that Relying Party Service.",
      );
    }

    const policy: PresentationPolicy = {
      id: newPresentationPolicyId(),
      tenantId: input.tenantId,
      relyingPartyServiceId: input.relyingPartyServiceId,
      intendedUseId: input.intendedUseId,
      name: input.name,
      description: input.description,
      status: "ACTIVE",
      createdAt: this.clock.now(),
    };
    await this.policies.createPolicy(policy);
    await this.audit.record({
      tenantId: input.tenantId,
      actor: "tenant",
      action: "presentation_policy.created",
      subjectType: "presentation_policy",
      subjectId: policy.id,
    });
    return policy;
  }

  async getPolicy(
    tenantId: TenantId,
    policyId: PresentationPolicyId,
  ): Promise<{
    readonly policy: PresentationPolicy;
    readonly versions: readonly PresentationPolicyVersion[];
  }> {
    const policy = await this.policies.findPolicy(tenantId, policyId);
    if (!policy) throw PlatformError.notFound("Presentation policy");
    const versions = await this.policies.listVersions(tenantId, policyId);
    return { policy, versions };
  }

  async createVersion(input: CreateVersionInput): Promise<PresentationPolicyVersion> {
    const policy = await this.policies.findPolicy(input.tenantId, input.policyId);
    if (!policy) throw PlatformError.notFound("Presentation policy");

    const intendedUse = await this.registration.findIntendedUse(
      input.tenantId,
      policy.intendedUseId,
    );
    if (!intendedUse) throw PlatformError.notFound("Intended use");

    const now = this.clock.now();
    const requestedClaims = dedupeRequestedClaims(input.requestedClaims);
    const candidate = {
      purpose: normaliseLocalisedText(input.purpose),
      credentialRequirements: input.credentialRequirements,
      requestedClaims,
      resultPolicy: input.resultPolicy,
      trustPolicy: input.trustPolicy ?? defaultTrustPolicy(),
      retentionPolicy: input.retentionPolicy ?? defaultRetentionPolicy(),
    };

    // The path-subset check, plus the purpose, privacy-policy, credential-registration and
    // result-policy rules. Every violation is returned, so one request fixes them all.
    const validation = validatePolicyVersion(candidate, { intendedUse, at: now });
    if (!validation.ok) {
      throw PlatformError.unprocessable(
        "policy_version_invalid",
        "The policy version is not valid for the referenced intended use.",
        validation.error,
      );
    }

    const existing = await this.policies.listVersions(input.tenantId, input.policyId);
    const version: PresentationPolicyVersion = {
      id: newPresentationPolicyVersionId(),
      tenantId: input.tenantId,
      policyId: input.policyId,
      version: nextVersionNumber(existing),
      ...candidate,
      status: "DRAFT",
      createdAt: now,
    };
    await this.policies.createVersion(version);

    if (input.publish) {
      await this.policies.publishVersion(input.tenantId, input.policyId, version.version, now);
    }

    await this.audit.record({
      tenantId: input.tenantId,
      actor: "tenant",
      action: input.publish
        ? "presentation_policy_version.published"
        : "presentation_policy_version.drafted",
      subjectType: "presentation_policy",
      subjectId: policy.id,
      policyId: policy.id,
      policyVersion: version.version,
      detail: {
        // Claim paths, never claim values.
        requestedClaims: requestedClaims.map((c) => c.path.join(".")),
      },
    });

    return input.publish ? { ...version, status: "PUBLISHED", publishedAt: now } : version;
  }

  async publishVersion(
    tenantId: TenantId,
    policyId: PresentationPolicyId,
    versionNumber: number,
  ): Promise<void> {
    const policy = await this.policies.findPolicy(tenantId, policyId);
    if (!policy) throw PlatformError.notFound("Presentation policy");

    const version = await this.policies.findVersion(tenantId, policyId, versionNumber);
    if (!version) throw PlatformError.notFound("Policy version");

    const intendedUse = await this.registration.findIntendedUse(tenantId, policy.intendedUseId);
    if (!intendedUse) throw PlatformError.notFound("Intended use");

    // Re-validated at publication: a registration may have changed since the draft was
    // written, and publishing is the point at which the version becomes immutable.
    const validation = validatePolicyVersion(version, { intendedUse, at: this.clock.now() });
    if (!validation.ok) {
      throw PlatformError.unprocessable(
        "policy_version_invalid",
        "The policy version is no longer valid for the referenced intended use.",
        validation.error,
      );
    }

    await this.policies.publishVersion(tenantId, policyId, versionNumber, this.clock.now());
    await this.audit.record({
      tenantId,
      actor: "tenant",
      action: "presentation_policy_version.published",
      subjectType: "presentation_policy",
      subjectId: policyId,
      policyId,
      policyVersion: versionNumber,
    });
  }
}
