import { PlatformError, type PlatformErrorDetail } from "@edtp/shared";

/**
 * An OpenID4VP claims path pointer.
 *
 * TS5 v1.5 models `Claim.path` as "a non-empty array of strings, nulls and
 * non-negative integers", referring to [OpenID4VP] Section 6.3, with Section 7.1
 * for `dc+sd-jwt` and Section 7.2 for `mso_mdoc`. The segment kinds mean:
 *
 * - `string`  — select the member with that name from an object
 * - `null`    — select **all** elements of an array (a wildcard)
 * - `integer` — select the element at that index of an array
 *
 * For `mso_mdoc` the first segment is the namespace, e.g.
 * `["eu.europa.ec.eudi.pid.1", "birth_date"]`. A flat attribute-name model would
 * flatten that away, which is why requested claims are modelled as paths
 * throughout — see ADR 0005 Decision 1c.
 */
export type ClaimPathSegment = string | number | null;
export type ClaimPath = readonly ClaimPathSegment[];

export interface RequestedClaim {
  readonly path: ClaimPath;
}

export const isValidSegment = (segment: unknown): segment is ClaimPathSegment => {
  if (segment === null) return true;
  if (typeof segment === "string") return segment.length > 0;
  if (typeof segment === "number") return Number.isInteger(segment) && segment >= 0;
  return false;
};

export const isValidClaimPath = (path: unknown): path is ClaimPath =>
  Array.isArray(path) && path.length > 0 && path.every(isValidSegment);

/** Stable, human-readable rendering used in error messages and audit records. */
export const formatClaimPath = (path: ClaimPath): string =>
  path.map((s) => (s === null ? "*" : typeof s === "number" ? `[${s}]` : s)).join(".");

/** Canonical key for set membership and de-duplication. */
export const claimPathKey = (path: ClaimPath): string => JSON.stringify(path);

export const claimPathEquals = (a: ClaimPath, b: ClaimPath): boolean =>
  a.length === b.length && a.every((s, i) => Object.is(s, b[i]));

/**
 * True when the `registered` segment permits the `requested` segment.
 *
 * A registered `null` is a wildcard over all array elements, so it covers both
 * another wildcard and any specific index. A registered index covers only the
 * identical index — a requested wildcard at that position would select more
 * elements than were registered.
 */
const segmentCovers = (registered: ClaimPathSegment, requested: ClaimPathSegment): boolean => {
  if (registered === null) return true;
  if (typeof registered === "string") return registered === requested;
  return typeof requested === "number" && registered === requested;
};

/**
 * True when `registered` permits `requested`.
 *
 * Per ADR 0005 Decision 2:
 *
 * - equal paths are permitted;
 * - a requested path that **extends** a registered path is permitted, because the
 *   registered claim is the broader disclosure — `["address","locality"]` is
 *   within a registered `["address"]`;
 * - a requested path that is a strict **prefix** of a registered path is refused,
 *   because it asks for more — `["address"]` is not within a registered
 *   `["address","locality"]`.
 */
export const claimPathCovers = (registered: ClaimPath, requested: ClaimPath): boolean => {
  if (registered.length > requested.length) return false;
  for (let i = 0; i < registered.length; i += 1) {
    const r = registered[i] as ClaimPathSegment;
    const q = requested[i] as ClaimPathSegment;
    if (!segmentCovers(r, q)) return false;
  }
  return true;
};

export const isClaimPathWithin = (
  requested: ClaimPath,
  registered: readonly ClaimPath[],
): boolean => registered.some((r) => claimPathCovers(r, requested));

export interface ClaimPathSubsetViolation {
  readonly requested: ClaimPath;
  readonly reason: "not_registered";
}

/**
 * Path-subset check: every requested path must be permitted by at least one
 * registered path. Returns every violation rather than the first, so a caller can
 * report all offending paths in one 422.
 */
export const findClaimPathViolations = (
  requested: readonly RequestedClaim[],
  registered: readonly ClaimPath[],
): readonly ClaimPathSubsetViolation[] => {
  const violations: ClaimPathSubsetViolation[] = [];
  for (const claim of requested) {
    if (!isClaimPathWithin(claim.path, registered)) {
      violations.push({ requested: claim.path, reason: "not_registered" });
    }
  }
  return violations;
};

export const claimPathViolationsToDetails = (
  violations: readonly ClaimPathSubsetViolation[],
): readonly PlatformErrorDetail[] =>
  violations.map((v) => ({
    path: formatClaimPath(v.requested),
    code: "claim_not_registered",
    message:
      `Claim path '${formatClaimPath(v.requested)}' is not within the attributes registered ` +
      "for the referenced intended use.",
  }));

export const parseClaimPath = (value: unknown, at: string): ClaimPath => {
  if (!isValidClaimPath(value)) {
    throw PlatformError.validation(
      "invalid_claim_path",
      "A claim path must be a non-empty array of strings, nulls and non-negative integers.",
      [{ path: at, code: "invalid_claim_path", message: "Invalid claim path." }],
    );
  }
  return value;
};

/** De-duplicates while preserving order, so a policy cannot double-count a claim. */
export const dedupeRequestedClaims = (
  claims: readonly RequestedClaim[],
): readonly RequestedClaim[] => {
  const seen = new Set<string>();
  const out: RequestedClaim[] = [];
  for (const c of claims) {
    const key = claimPathKey(c.path);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
};

/**
 * Reads the value at a claim path from a disclosed-claims object.
 *
 * Used only by the result policy, inside the same call stack that receives the
 * engine result. Wildcard and index segments resolve against arrays; a missing
 * member yields `undefined` rather than throwing, because an absent optional
 * claim is a normal outcome.
 */
export const readClaimAtPath = (source: unknown, path: ClaimPath): unknown => {
  let current: unknown = source;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (segment === null) {
      if (!Array.isArray(current)) return undefined;
      return current;
    }
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};
