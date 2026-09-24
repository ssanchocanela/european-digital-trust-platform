import { err, ok, type PlatformErrorDetail, type Result } from "@edtp/shared";
import type { IntendedUse, RegisteredCredential } from "../kernel/registration.js";
import {
  type ClaimPath,
  claimPathViolationsToDetails,
  findClaimPathViolations,
  formatClaimPath,
  isValidClaimPath,
} from "./claim-path.js";
import type {
  CredentialRequirement,
  PresentationPolicyVersion,
} from "./presentation-policy.js";
import { findResultPolicyViolations } from "./result-policy.js";

/**
 * Validation of a policy version against the intended use it references.
 *
 * The governing requirement is `EW-DM-44-027` (`RPRC_21`): a Wallet Unit verifies that
 * all attributes requested in a presentation request are included in the attribute
 * list of the registration certificate, and warns the User that "the Relying Party is
 * requesting more information than it has registered" when they are not.
 *
 * Three layers check this, and the platform owns the earliest:
 *
 * 1. **here**, at policy publication — HTTP 422 before any customer traffic and
 *    before any User sees a warning;
 * 2. the engine, at request time, at credential granularity against the registration
 *    certificate's authorised `credentials` claim;
 * 3. the Wallet, at attribute granularity per `RPRC_21`.
 *
 * The compiler re-runs this check at transaction time, so a registration change after
 * publication cannot silently widen a request.
 */

export interface PolicyValidationContext {
  readonly intendedUse: IntendedUse;
  /** Evaluation time, used to check that the intended use is still valid. */
  readonly at: Date;
}

const matchesRequirement = (
  registered: RegisteredCredential,
  requirement: CredentialRequirement,
): boolean => {
  if (!requirement.acceptedFormats.includes(registered.format)) return false;
  if (registered.format === "dc+sd-jwt") {
    return (registered.vctValues ?? []).includes(requirement.credentialType);
  }
  return registered.doctype === requirement.credentialType;
};

/**
 * The registered claim paths available for a requirement.
 *
 * Only credentials that match both the credential type and an accepted format
 * contribute. A claim registered under a different credential type must not widen
 * what this policy may request.
 */
export const registeredClaimsFor = (
  intendedUse: IntendedUse,
  requirement: CredentialRequirement,
): readonly ClaimPath[] =>
  intendedUse.registeredCredentials
    .filter((rc) => matchesRequirement(rc, requirement))
    .flatMap((rc) => rc.claims);

export const findMatchingRegisteredCredentials = (
  intendedUse: IntendedUse,
  requirement: CredentialRequirement,
): readonly RegisteredCredential[] =>
  intendedUse.registeredCredentials.filter((rc) => matchesRequirement(rc, requirement));

export type PolicyValidationFailure = readonly PlatformErrorDetail[];

export const validatePolicyVersion = (
  version: Pick<
    PresentationPolicyVersion,
    | "purpose"
    | "credentialRequirements"
    | "requestedClaims"
    | "resultPolicy"
    | "retentionPolicy"
  >,
  context: PolicyValidationContext,
): Result<true, PolicyValidationFailure> => {
  const details: PlatformErrorDetail[] = [];
  const { intendedUse, at } = context;

  // The intended use must still be valid. TS5 `IntendedUse.revokedAt` marks expiry or
  // revocation, and a policy must not be published against a lapsed registration.
  if (intendedUse.validFrom.getTime() > at.getTime()) {
    details.push({
      path: "intendedUseId",
      code: "intended_use_not_yet_valid",
      message: "The referenced intended use is not yet valid.",
    });
  }
  if (intendedUse.revokedAt && intendedUse.revokedAt.getTime() <= at.getTime()) {
    details.push({
      path: "intendedUseId",
      code: "intended_use_revoked",
      message: "The referenced intended use has expired or been revoked.",
    });
  }

  // TS5 models `IntendedUse.purpose` and `privacyPolicy` as [1..*] and the Wallet
  // displays both — `AS-WP-06-015` (`RPA_10`). A policy with no purpose text would
  // leave the Wallet nothing to show.
  if (version.purpose.length === 0) {
    details.push({
      path: "purpose",
      code: "purpose_required",
      message:
        "At least one localised purpose is required; the Wallet displays it to the User.",
    });
  }
  if (!version.purpose.some((p) => p.lang.toLowerCase() === "en")) {
    details.push({
      path: "purpose",
      code: "purpose_missing_en",
      message: "A purpose localisation for 'en' is required in V0 as the fallback language.",
    });
  }
  if (intendedUse.privacyPolicyUris.length === 0) {
    details.push({
      path: "intendedUseId",
      code: "privacy_policy_required",
      message:
        "The referenced intended use has no privacy policy. The Wallet shows the privacy policy " +
        "link to the User, so a policy version cannot be published against it.",
    });
  }

  // V0 constraint: exactly one credential requirement, modelled as a one-element list.
  if (version.credentialRequirements.length !== 1) {
    details.push({
      path: "credentialRequirements",
      code: "single_credential_requirement",
      message:
        "V0 supports exactly one credential requirement per presentation policy version.",
    });
  }

  const requirement = version.credentialRequirements[0];
  if (requirement) {
    if (requirement.acceptedFormats.length === 0) {
      details.push({
        path: "credentialRequirements[0].acceptedFormats",
        code: "accepted_formats_required",
        message: "At least one accepted credential format is required.",
      });
    }

    const matching = findMatchingRegisteredCredentials(intendedUse, requirement);
    if (matching.length === 0) {
      details.push({
        path: "credentialRequirements[0]",
        code: "credential_not_registered",
        message:
          `Credential type '${requirement.credentialType}' in format(s) ` +
          `${requirement.acceptedFormats.join(", ")} is not registered for the referenced ` +
          "intended use.",
      });
    } else {
      const registered = registeredClaimsFor(intendedUse, requirement);
      // Name the offending entry by index: a malformed path cannot be rendered by
      // `formatClaimPath`, so the index is the only stable way to point at it.
      version.requestedClaims.forEach((claim, index) => {
        if (isValidClaimPath(claim.path)) return;
        details.push({
          path: `requestedClaims[${index}]`,
          code: "invalid_claim_path",
          message:
            "A claim path must be a non-empty array of strings, nulls and non-negative integers.",
        });
      });
      if (version.requestedClaims.length === 0) {
        details.push({
          path: "requestedClaims",
          code: "requested_claims_required",
          message: "At least one requested claim is required.",
        });
      }
      // The path-subset check. See ADR 0005 Decision 2 for the semantics.
      details.push(
        ...claimPathViolationsToDetails(
          findClaimPathViolations(version.requestedClaims, registered),
        ),
      );
    }
  }

  // A result policy may only read claims the version actually requests.
  for (const offending of findResultPolicyViolations(
    version.resultPolicy,
    version.requestedClaims.map((c) => c.path),
  )) {
    details.push({
      path: "resultPolicy",
      code: "result_policy_reads_unrequested_claim",
      message:
        `The result policy reads '${offending}', which the policy version does not request. ` +
        "A result policy may only read requested claims.",
    });
  }

  if (version.retentionPolicy.transactionLifetimeSeconds < 60) {
    details.push({
      path: "retentionPolicy.transactionLifetimeSeconds",
      code: "transaction_lifetime_too_short",
      message:
        "The transaction lifetime must be at least 60 seconds, which is the minimum session " +
        "time-to-live the engine accepts.",
    });
  }

  return details.length === 0 ? ok(true) : err(details);
};

/** Human-readable summary used in audit records; contains no claim values. */
export const describeRequestedClaims = (version: PresentationPolicyVersion): string =>
  version.requestedClaims.map((c) => formatClaimPath(c.path)).join(", ");
