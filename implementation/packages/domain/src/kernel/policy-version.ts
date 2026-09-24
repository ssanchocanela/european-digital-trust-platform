import { PlatformError } from "@edtp/shared";

/**
 * Generic policy versioning, built in Milestone 1 so that issuance reuses it
 * unchanged in Milestone 2.
 *
 * `draft -> published -> retired`. A published version is **immutable**: every
 * transaction snapshots or references the exact version it used, so a later edit
 * cannot rewrite history.
 */
export const POLICY_STATUSES = ["DRAFT", "PUBLISHED", "RETIRED"] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

/** Lifecycle of the policy container, independent of its versions. */
export const POLICY_CONTAINER_STATUSES = ["ACTIVE", "RETIRED"] as const;
export type PolicyContainerStatus = (typeof POLICY_CONTAINER_STATUSES)[number];

const ALLOWED_VERSION_TRANSITIONS: Readonly<Record<PolicyStatus, readonly PolicyStatus[]>> = {
  DRAFT: ["PUBLISHED", "RETIRED"],
  PUBLISHED: ["RETIRED"],
  RETIRED: [],
};

export const canTransitionPolicyStatus = (from: PolicyStatus, to: PolicyStatus): boolean =>
  ALLOWED_VERSION_TRANSITIONS[from].includes(to);

export const assertPolicyTransition = (from: PolicyStatus, to: PolicyStatus): void => {
  if (!canTransitionPolicyStatus(from, to)) {
    throw PlatformError.conflict(
      "illegal_policy_transition",
      `A policy version cannot move from ${from} to ${to}.`,
    );
  }
};

/**
 * Retiring a policy container, and bringing one back.
 *
 * **Reversible, and deliberately so** — the opposite of `AS-AP-07-007` (`VCR_04`), which makes an
 * attestation's revocation irreversible. The two look similar and are not. Revoking an attestation
 * makes a statement about a credential somebody holds, and un-saying it would let a provider
 * rehabilitate something it had declared bad. Retiring a *policy* only stops new transactions
 * starting: attestations already issued keep the terms they were issued under, every transaction
 * still references the exact version it used, and nothing a holder has is changed. A policy retired
 * by mistake should therefore be recoverable, because the alternative is a permanent scar on a
 * tenant for a mis-click.
 *
 * A no-op is refused rather than silently accepted, so a caller that believes it changed something
 * is told it did not.
 */
export const assertPolicyContainerTransition = (
  from: PolicyContainerStatus,
  to: PolicyContainerStatus,
): void => {
  if (from === to) {
    throw PlatformError.conflict("policy_already_in_status", `The policy is already ${from}.`);
  }
};

/** Thrown when a caller attempts to modify a published version. */
export const assertVersionMutable = (status: PolicyStatus): void => {
  if (status !== "DRAFT") {
    throw PlatformError.conflict(
      "policy_version_immutable",
      `A ${status} policy version is immutable and cannot be modified.`,
    );
  }
};

/** Fields every policy version carries, whatever its body. */
export interface PolicyVersionMetadata {
  /** Monotonic within the policy, starting at 1. */
  readonly version: number;
  readonly status: PolicyStatus;
  readonly createdAt: Date;
  readonly publishedAt?: Date;
  readonly retiredAt?: Date;
}

export const nextVersionNumber = (existing: readonly { version: number }[]): number =>
  existing.reduce((max, v) => (v.version > max ? v.version : max), 0) + 1;

/**
 * Resolves the version a transaction should use.
 *
 * With no explicit version, the latest **published** version is used; a draft is
 * never resolvable by default, because an unpublished policy has not been validated
 * for use. An explicit version is honoured only when published, so a transaction can
 * never reference a draft or a retired version.
 */
export const resolvePublishedVersion = <T extends PolicyVersionMetadata>(
  versions: readonly T[],
  explicit?: number,
): T => {
  const published = versions.filter((v) => v.status === "PUBLISHED");
  if (explicit !== undefined) {
    const match = published.find((v) => v.version === explicit);
    if (!match) {
      throw PlatformError.notFound(`Published policy version ${explicit}`);
    }
    return match;
  }
  if (published.length === 0) {
    throw PlatformError.conflict(
      "no_published_policy_version",
      "The policy has no published version. Publish a version before creating a transaction.",
    );
  }
  return published.reduce((latest, v) => (v.version > latest.version ? v : latest));
};
