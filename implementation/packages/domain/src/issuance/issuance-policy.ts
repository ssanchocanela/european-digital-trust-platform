import type { LocalisedText } from "@edtp/shared";
import { PlatformError } from "@edtp/shared";
import type { RetentionPolicy } from "../kernel/policies.js";
import type { PolicyStatus } from "../kernel/policy-version.js";
import { type CredentialType, declaredClaimPaths } from "./credential-type.js";

/**
 * How the subject's eligibility is decided.
 *
 * A named, registered implementation — not an expression language, not a rules engine. The V0 plan
 * asks for "a small explicit interface", and the reason is that an eligibility rule decides whether
 * someone receives an attestation about themselves: it should be readable code under review, not a
 * string in a database.
 */
export interface EligibilityRuleRef {
  /** Name of an `EligibilityEvaluator` registered at startup. Resolved then, not at runtime. */
  readonly evaluator: string;
  /** Parameters the evaluator declares. Shape is the evaluator's business. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** Which connector supplies attribute values, and how it is labelled. */
export interface AuthenticSourceRef {
  readonly connector: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export const HOLDER_BINDING_MODES = ["KEY_BOUND", "BEARER"] as const;
export type HolderBindingMode = (typeof HOLDER_BINDING_MODES)[number];

export const ISSUANCE_FLOW_KINDS = ["PRE_AUTHORIZED_CODE", "AUTHORIZATION_CODE"] as const;
export type IssuanceFlowKind = (typeof ISSUANCE_FLOW_KINDS)[number];

/**
 * Revocation and suspension intent for attestations issued under this policy.
 *
 * `VCR_04` (`AS-AP-07-007`) is the load-bearing rule and it is enforced in
 * `credential-status.ts`, not here — this only records what the policy asks for.
 */
export interface StatusPolicy {
  /** Whether a status list is maintained at all. Must agree with the credential type. */
  readonly statusListEnabled: boolean;
  /** Whether suspension (reversible) is offered in addition to revocation (not reversible). */
  readonly suspensionAllowed: boolean;
}

export interface IssuancePolicyVersionInput {
  readonly credentialTypeId: string;
  readonly purpose: readonly LocalisedText[];
  readonly eligibilityRule: EligibilityRuleRef;
  readonly authenticSource: AuthenticSourceRef;
  readonly holderBinding: HolderBindingMode;
  readonly flow: IssuanceFlowKind;
  readonly credentialValiditySeconds: number;
  readonly statusPolicy: StatusPolicy;
  readonly retentionPolicy: RetentionPolicy;
  /**
   * Optional: require a PID presentation before issuing, reusing a verification policy.
   *
   * The stretch goal in §7.3 of the V0 plan. Modelled now because leaving it out would have made
   * it a structural change later; whether the engine supports it is a separate question recorded
   * in `docs/eudiplo-integration.md`.
   */
  readonly eligibilityPresentationPolicyId?: string;
}

export interface IssuancePolicyVersion extends IssuancePolicyVersionInput {
  readonly policyId: string;
  readonly version: number;
  readonly status: PolicyStatus;
  readonly createdAt: Date;
  readonly publishedAt?: Date;
}

export interface IssuancePolicy {
  readonly id: string;
  readonly tenantId: string;
  readonly credentialTypeId: string;
  readonly name: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly createdAt: Date;
}

/**
 * Validates a policy version against the credential type it issues.
 *
 * The analogue of `validatePolicyVersion` on the verification side, and for the same reason:
 * catching a contradiction at publication costs nothing, while catching it during an issuance
 * means a User has already been asked to accept something the platform cannot deliver.
 */
export const validateIssuancePolicyVersion = (
  input: IssuancePolicyVersionInput,
  context: {
    readonly credentialType: CredentialType;
    readonly registeredEvaluators: readonly string[];
    readonly registeredConnectors: readonly string[];
    readonly at: Date;
  },
): void => {
  const details: { path: string; code: string; message: string }[] = [];
  const { credentialType } = context;

  if (input.credentialTypeId !== credentialType.id) {
    details.push({
      path: "credentialTypeId",
      code: "credential_type_mismatch",
      message: "The referenced credential type does not match the one supplied for validation.",
    });
  }

  if (input.purpose.length === 0) {
    details.push({
      path: "purpose",
      code: "purpose_required",
      message:
        "A purpose is required and is localised and multi-valued, as on the verification side: " +
        "the Wallet displays it to the User when asking for approval.",
    });
  }

  // A named evaluator must exist. Resolving at publication rather than at issuance means a
  // typo fails when a reviewer is present, not when a User is waiting.
  if (!context.registeredEvaluators.includes(input.eligibilityRule.evaluator)) {
    details.push({
      path: "eligibilityRule.evaluator",
      code: "evaluator_not_registered",
      message:
        `No EligibilityEvaluator named '${input.eligibilityRule.evaluator}' is registered. ` +
        `Registered: ${context.registeredEvaluators.join(", ") || "(none)"}.`,
    });
  }
  if (!context.registeredConnectors.includes(input.authenticSource.connector)) {
    details.push({
      path: "authenticSource.connector",
      code: "connector_not_registered",
      message:
        `No AuthenticSourceConnector named '${input.authenticSource.connector}' is registered. ` +
        `Registered: ${context.registeredConnectors.join(", ") || "(none)"}.`,
    });
  }

  // Holder binding must agree with the type. A KEY_BOUND policy over a type that does not require
  // key binding would silently issue a bearer attestation.
  if (input.holderBinding === "KEY_BOUND" && !credentialType.requiresKeyBinding) {
    details.push({
      path: "holderBinding",
      code: "holder_binding_unsupported",
      message:
        "The policy requires key binding but the credential type does not declare it. Issuing " +
        "would produce a bearer attestation while the policy claims otherwise.",
    });
  }
  if (input.holderBinding === "BEARER" && credentialType.requiresKeyBinding) {
    details.push({
      path: "holderBinding",
      code: "holder_binding_required",
      message:
        "The credential type requires key binding, so the policy cannot issue as bearer.",
    });
  }

  // The status policy must agree with the type's mechanism, or revocation silently does nothing.
  const typeHasStatus = credentialType.statusMechanism === "TOKEN_STATUS_LIST";
  if (input.statusPolicy.statusListEnabled && !typeHasStatus) {
    details.push({
      path: "statusPolicy.statusListEnabled",
      code: "status_mechanism_absent",
      message:
        "The policy enables a status list but the credential type declares no status mechanism, " +
        "so revocation would have no effect. `AS-AP-07-007` (`VCR_04`) makes revocation " +
        "irreversible once it works; a revocation that silently does nothing is worse.",
    });
  }
  if (!input.statusPolicy.statusListEnabled && typeHasStatus) {
    details.push({
      path: "statusPolicy.statusListEnabled",
      code: "status_mechanism_unused",
      message:
        "The credential type declares a status mechanism but the policy disables it. Decide one " +
        "way: an attestation that cannot be revoked must say so in its type.",
    });
  }
  if (input.statusPolicy.suspensionAllowed && !input.statusPolicy.statusListEnabled) {
    details.push({
      path: "statusPolicy.suspensionAllowed",
      code: "suspension_requires_status_list",
      message: "Suspension needs a status list.",
    });
  }

  if (input.credentialValiditySeconds <= 0) {
    details.push({
      path: "credentialValiditySeconds",
      code: "validity_invalid",
      message: "Credential validity must be positive.",
    });
  }
  if (input.credentialValiditySeconds > credentialType.validitySeconds) {
    details.push({
      path: "credentialValiditySeconds",
      code: "validity_exceeds_type",
      message:
        `The policy asks for ${input.credentialValiditySeconds}s but the credential type caps ` +
        `validity at ${credentialType.validitySeconds}s. A policy may shorten a type's validity, ` +
        "never extend it.",
    });
  }

  // An unverifiable attestation must not be issued: ARF §6.3.2.4 sources anchors from the
  // Rulebook, so a type whose Rulebook expects a published list needs one to exist.
  if (
    credentialType.rulebook.anchorSource === "RULEBOOK_AND_PUBLISHED_LIST" &&
    !credentialType.rulebook.publicationUri
  ) {
    details.push({
      path: "credentialTypeId",
      code: "rulebook_publication_missing",
      message:
        "The credential type's Rulebook declares that anchors come from a published list " +
        "(ARF §6.3.2.4), but no publication URI is recorded, so a verifier could not resolve " +
        "them. Publish the list, or declare RULEBOOK_ONLY.",
    });
  }

  if (details.length > 0) {
    throw PlatformError.unprocessable(
      "issuance_policy_version_invalid",
      "The issuance policy version is not valid.",
      details,
    );
  }
};

/**
 * The claims an issuance under this policy will request from the authentic source.
 *
 * Exactly the type's declared claims — the policy cannot widen them. Minimisation at the source,
 * as the verification side does it, rather than fetching everything and filtering later.
 */
export const claimsToFetch = (credentialType: CredentialType): readonly string[] =>
  declaredClaimPaths(credentialType);
