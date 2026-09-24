import type { LocalisedText } from "@edtp/shared";
import { PlatformError } from "@edtp/shared";
import type { RetentionPolicy, TrustPolicy } from "../kernel/policies.js";
import type {
  AccessCertificate,
  CredentialFormat,
  IntendedUse,
  RegistrationCertificate,
  RelyingParty,
  RelyingPartyInstance,
  RelyingPartyService,
} from "../kernel/registration.js";
import { dedupeRequestedClaims, type RequestedClaim } from "./claim-path.js";
import { registeredClaimsFor, validatePolicyVersion } from "./policy-validation.js";
import {
  type CredentialRequirement,
  type PresentationPolicyVersion,
  soleCredentialRequirement,
} from "./presentation-policy.js";
import type { ResultPolicy } from "./result-policy.js";

/**
 * The internal, immutable instruction set the adapter executes.
 *
 * **No protocol structure appears here.** DCQL, `client_id` schemes, response modes
 * and engine configuration objects are produced inside the adapter from this plan —
 * ADR 0002 Decision 2. The plan is what the domain knows; the protocol is what the
 * adapter knows.
 */
export interface PlanRelyingPartyContext {
  /** Registrar-assigned, EU-wide unique — `AS-MS-27-043` (`Reg_32`). */
  readonly relyingPartyIdentifier: string;
  /** RP-chosen, unique within the RP — `AS-MS-27-045` (`Reg_33`). */
  readonly serviceIdentifier: string;
  /** Displayed to the User by the Wallet — `AS-WP-06-007` (`RPA_06`). */
  readonly serviceTradeName: string;
  /** Registrar-provided identifier of the registered intended use. */
  readonly intendedUseIdentifier: string;
  /**
   * The registration certificate to attach, by value — `EW-DM-44-023` (`RPRC_19`).
   *
   * Absent in V0, because no provider of registration certificates is reachable
   * (blocker B3). When absent the adapter sends the request without one and the
   * platform reports that fact; it is never fabricated.
   */
  readonly registrationCertificateJwt?: string;
  /** Opaque reference to the key chain holding the access-certificate key. */
  readonly accessKeyBindingRef: string;
  /** Opaque reference to the engine tenant serving this Relying Party Instance. */
  readonly engineTenantRef: string;
}

export interface PlanCredentialRequirement {
  readonly credentialType: string;
  readonly acceptedFormats: readonly CredentialFormat[];
  /** Per-format metadata the adapter needs: `vct_values` or a document type. */
  readonly vctValues?: readonly string[];
  readonly doctype?: string;
}

export interface VerificationPlan {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly purpose: readonly LocalisedText[];
  readonly credentialRequirement: PlanCredentialRequirement;
  readonly requestedClaims: readonly RequestedClaim[];
  readonly trustConstraints: TrustPolicy;
  readonly resultTransformation: ResultPolicy;
  readonly retentionInstructions: RetentionPolicy;
  readonly relyingPartyContext: PlanRelyingPartyContext;
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
};

export interface CompilerInput {
  readonly policyVersion: PresentationPolicyVersion;
  readonly relyingParty: RelyingParty;
  readonly relyingPartyService: RelyingPartyService;
  readonly relyingPartyInstance: RelyingPartyInstance;
  readonly intendedUse: IntendedUse;
  readonly registrationCertificate?: RegistrationCertificate;
  readonly accessCertificate: AccessCertificate;
  readonly at: Date;
}

/**
 * Builds the adapter metadata for a requirement from the matching registered
 * credentials, so the adapter never has to interpret the credential type itself.
 */
const planRequirement = (
  requirement: CredentialRequirement,
  intendedUse: IntendedUse,
): PlanCredentialRequirement => {
  const sdJwt = requirement.acceptedFormats.includes("dc+sd-jwt");
  const mdoc = requirement.acceptedFormats.includes("mso_mdoc");
  const matching = intendedUse.registeredCredentials.filter((rc) =>
    requirement.acceptedFormats.includes(rc.format),
  );
  const vctValues = sdJwt
    ? [
        ...new Set(
          matching
            .filter((rc) => rc.format === "dc+sd-jwt")
            .flatMap((rc) => rc.vctValues ?? [])
            .filter((v) => v === requirement.credentialType),
        ),
      ]
    : undefined;
  const doctype = mdoc
    ? matching.find(
        (rc) => rc.format === "mso_mdoc" && rc.doctype === requirement.credentialType,
      )?.doctype
    : undefined;

  return {
    credentialType: requirement.credentialType,
    acceptedFormats: requirement.acceptedFormats,
    ...(vctValues && vctValues.length > 0 ? { vctValues } : {}),
    ...(doctype ? { doctype } : {}),
  };
};

/**
 * Compiles a published policy version into an immutable `VerificationPlan`.
 *
 * Re-validates against the intended use, so a registration change after publication
 * cannot silently widen a request, and refuses to compile a plan whose access
 * certificate or registration material is in the wrong trust environment.
 */
export const compilePresentationPolicy = (input: CompilerInput): VerificationPlan => {
  const {
    policyVersion,
    relyingParty,
    relyingPartyService,
    relyingPartyInstance,
    intendedUse,
    registrationCertificate,
    accessCertificate,
    at,
  } = input;

  if (policyVersion.status !== "PUBLISHED") {
    throw PlatformError.conflict(
      "policy_version_not_published",
      `Only a published policy version can be compiled; this version is ${policyVersion.status}.`,
    );
  }

  // Trust material must belong to the same environment as the Relying Party. Mixing
  // a TEST certificate into a PRODUCTION registration, or the reverse, would
  // misrepresent the requester.
  const environments = new Set([
    relyingParty.trustEnvironment,
    relyingPartyInstance.trustEnvironment,
    accessCertificate.trustEnvironment,
    ...(registrationCertificate ? [registrationCertificate.trustEnvironment] : []),
  ]);
  if (environments.size !== 1) {
    throw PlatformError.conflict(
      "mixed_trust_environments",
      "The Relying Party, instance and trust material must all share one trust environment.",
    );
  }

  // `AS-MS-27-016` (`Reg_10d`): intended uses are registered per Service. A policy must not
  // borrow another Service's intended use, and the Wallet would reject the mismatch anyway
  // because the registration certificate carries the Service identifier (`RPRC_10`).
  if (intendedUse.relyingPartyServiceId !== relyingPartyService.id) {
    throw PlatformError.conflict(
      "intended_use_service_mismatch",
      "The intended use is not registered for the Relying Party Service of this policy.",
    );
  }

  if (relyingPartyInstance.relyingPartyServiceId !== relyingPartyService.id) {
    throw PlatformError.conflict(
      "instance_service_mismatch",
      "The Relying Party Instance does not serve the Relying Party Service of this policy.",
    );
  }

  if (relyingPartyService.relyingPartyId !== relyingParty.id) {
    throw PlatformError.conflict(
      "service_relying_party_mismatch",
      "The Relying Party Service does not belong to that Relying Party.",
    );
  }

  if (accessCertificate.relyingPartyServiceId !== relyingPartyService.id) {
    throw PlatformError.conflict(
      "access_certificate_service_mismatch",
      "The access certificate is not bound to the Relying Party Service of this policy.",
    );
  }

  // `AS-MS-27-018` (`Reg_11`) and `AS-WP-06-003` (`RPA_02`) make the access certificate
  // the basis of Relying Party authentication; an expired one cannot authenticate.
  if (accessCertificate.notAfter && accessCertificate.notAfter.getTime() <= at.getTime()) {
    throw PlatformError.conflict(
      "access_certificate_expired",
      "The access certificate for this Relying Party Service has expired.",
    );
  }

  if (registrationCertificate) {
    if (registrationCertificate.intendedUseId !== intendedUse.id) {
      // `EW-DM-44-014` (`RPRC_09`): one certificate per (intended use x Service).
      throw PlatformError.conflict(
        "registration_certificate_intended_use_mismatch",
        "The registration certificate is not the one issued for this intended use.",
      );
    }
    if (
      registrationCertificate.notAfter &&
      registrationCertificate.notAfter.getTime() <= at.getTime()
    ) {
      throw PlatformError.conflict(
        "registration_certificate_expired",
        "The registration certificate for this intended use has expired.",
      );
    }
  }

  const revalidated = validatePolicyVersion(policyVersion, { intendedUse, at });
  if (!revalidated.ok) {
    throw PlatformError.unprocessable(
      "policy_no_longer_valid",
      "The policy version is no longer valid against its intended use and cannot be compiled.",
      revalidated.error,
    );
  }

  const requirement = soleCredentialRequirement(policyVersion);

  // Defence in depth: assert the subset property on the exact paths that will be sent.
  const registered = registeredClaimsFor(intendedUse, requirement);
  if (registered.length === 0) {
    throw PlatformError.unprocessable(
      "no_registered_claims",
      "The intended use registers no claims for this credential requirement.",
    );
  }

  const plan: VerificationPlan = {
    policyId: policyVersion.policyId,
    policyVersion: policyVersion.version,
    purpose: policyVersion.purpose,
    credentialRequirement: planRequirement(requirement, intendedUse),
    requestedClaims: dedupeRequestedClaims(policyVersion.requestedClaims),
    trustConstraints: policyVersion.trustPolicy,
    resultTransformation: policyVersion.resultPolicy,
    retentionInstructions: policyVersion.retentionPolicy,
    relyingPartyContext: {
      relyingPartyIdentifier: relyingParty.registrarAssignedIdentifier,
      serviceIdentifier: relyingPartyService.serviceIdentifier,
      serviceTradeName: relyingPartyService.serviceTradeName,
      intendedUseIdentifier: intendedUse.intendedUseIdentifier,
      ...(registrationCertificate?.jwt
        ? { registrationCertificateJwt: registrationCertificate.jwt }
        : {}),
      accessKeyBindingRef: accessCertificate.keyBindingRef,
      engineTenantRef: relyingPartyInstance.engineTenantRef,
    },
  };

  return deepFreeze(plan);
};
