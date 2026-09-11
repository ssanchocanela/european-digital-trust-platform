import {
  type ClaimPath,
  claimPathKey,
  formatClaimPath,
  readClaimAtPath,
} from "./claim-path.js";

/**
 * The result exposed to the consuming service.
 *
 * Two kinds, per the V0 plan:
 *
 * - `VERIFIED_CLAIMS` returns only explicitly allowed verified attributes;
 * - `DERIVED_CLAIMS` returns a derived, minimised result through a small explicit
 *   transformation interface.
 *
 * **No expression language and no rules engine.** Transformations are named
 * implementations registered at startup, which is also consistent with the existing
 * knowledge base recording policy-engine technology as an open question.
 */

export interface VerifiedClaimsResultPolicy {
  readonly kind: "VERIFIED_CLAIMS";
  /** Only these claim paths are returned. Must be a subset of the requested claims. */
  readonly allowedClaims: readonly ClaimPath[];
}

/**
 * A derivation, identified by name with explicit parameters.
 *
 * `AgeAtLeast` is the V0 transformation. ADR 0005 Decision 5 records why it is the
 * primary path rather than a fallback: `age_over_18` and `age_over_NN` were removed
 * from the PID by PID Rulebook v1.1 following CIR 2024/2977, and the live reference
 * PID issuer advertises no age claim in either format. Deriving from the date of
 * birth is therefore the only available minimising route for an age check over a PID.
 */
export interface AgeAtLeastDerivation {
  readonly name: "AgeAtLeast";
  /** The claim path of the source date of birth. */
  readonly sourcePath: ClaimPath;
  readonly minimumAgeYears: number;
  /** The single output field name, e.g. `over_18`. */
  readonly outputClaim: string;
}

/** Returns whether a named claim is present and non-empty, without returning its value. */
export interface ClaimPresenceDerivation {
  readonly name: "ClaimPresence";
  readonly sourcePath: ClaimPath;
  readonly outputClaim: string;
}

/** Returns whether a claim equals one of an allowed set, without returning the value. */
export interface ClaimInSetDerivation {
  readonly name: "ClaimInSet";
  readonly sourcePath: ClaimPath;
  readonly allowedValues: readonly string[];
  readonly outputClaim: string;
}

export type Derivation = AgeAtLeastDerivation | ClaimPresenceDerivation | ClaimInSetDerivation;

export interface DerivedClaimsResultPolicy {
  readonly kind: "DERIVED_CLAIMS";
  readonly derivations: readonly Derivation[];
}

export type ResultPolicy = VerifiedClaimsResultPolicy | DerivedClaimsResultPolicy;

/** Every claim path a result policy reads, used to validate it against the policy. */
export const claimPathsReadBy = (policy: ResultPolicy): readonly ClaimPath[] =>
  policy.kind === "VERIFIED_CLAIMS"
    ? policy.allowedClaims
    : policy.derivations.map((d) => d.sourcePath);

export type NormalisedClaims = Readonly<Record<string, unknown>>;

/**
 * Disclosed claims as received from the engine.
 *
 * This value is **content**. It exists only inside the call stack that receives the
 * engine result, is never persisted and never logged, and is discarded as soon as the
 * result policy has been applied — ARF `AS-RP-01-002` (`OIA_16`). See ADR 0004.
 */
export type DisclosedClaims = Readonly<Record<string, unknown>>;

/**
 * Keys that must be stripped from any result, whatever the policy says.
 *
 * `AS-RP-01-002` (`OIA_16`) forbids communicating the `AS-AP-10-064` (`ISSU_35`)
 * unique elements — per-attribute salts, attribute hash values, the revocation index,
 * the device-binding public key and the provider signature value — to the Relying
 * Party **or to any other party**. In the V0 hosted profile the platform is the
 * Relying Party Instance, so this applies to the customer-facing result and not only
 * to storage. Stripping happens after the policy runs, so no policy can opt out.
 */
const UNIQUE_ELEMENT_KEYS: readonly string[] = [
  "_sd",
  "_sd_alg",
  "sd_hash",
  "salt",
  "cnf",
  "status",
  "x5c",
  "issuanceThumbprint",
  "revocationThumbprint",
  "deviceKey",
  "device_key",
];

const stripUniqueElements = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    return value.map((v) => stripUniqueElements(v, depth + 1)).filter((v) => v !== undefined);
  }
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (UNIQUE_ELEMENT_KEYS.includes(k)) continue;
      const cleaned = stripUniqueElements(v, depth + 1);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
};

export interface ResultPolicyOutcome {
  readonly claims: NormalisedClaims;
  /**
   * True when the policy could not be satisfied from the disclosed claims — a source
   * attribute a derivation needs was absent, or an allowed claim was not disclosed.
   * The caller maps this to the `POLICY_NOT_SATISFIED` terminal outcome.
   */
  readonly satisfied: boolean;
  readonly unsatisfiedReasons: readonly string[];
}

const parseDateOfBirth = (raw: unknown): Date | undefined => {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  // ISO 8601 full-date, the form both `dc+sd-jwt` and `mso_mdoc` PID encodings use.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) {
    const [, y, m, d] = iso;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

/**
 * Whole years elapsed, computed on calendar boundaries in UTC rather than by dividing
 * milliseconds, so leap years and the day before a birthday are handled correctly.
 */
export const completedYearsBetween = (birth: Date, at: Date): number => {
  let years = at.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = at.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && at.getUTCDate() < birth.getUTCDate())) {
    years -= 1;
  }
  return years;
};

const applyDerivation = (
  derivation: Derivation,
  disclosed: DisclosedClaims,
  at: Date,
): { readonly key: string; readonly value: unknown } | { readonly unsatisfied: string } => {
  const raw = readClaimAtPath(disclosed, derivation.sourcePath);
  if (raw === undefined || raw === null || raw === "") {
    return {
      unsatisfied:
        `The source claim '${formatClaimPath(derivation.sourcePath)}' required by derivation ` +
        `'${derivation.name}' was not disclosed.`,
    };
  }

  switch (derivation.name) {
    case "AgeAtLeast": {
      const birth = parseDateOfBirth(raw);
      if (!birth) {
        return {
          unsatisfied:
            `The source claim '${formatClaimPath(derivation.sourcePath)}' is not a parsable date, ` +
            "so the age derivation could not be evaluated.",
        };
      }
      const years = completedYearsBetween(birth, at);
      return { key: derivation.outputClaim, value: years >= derivation.minimumAgeYears };
    }
    case "ClaimPresence":
      return { key: derivation.outputClaim, value: true };
    case "ClaimInSet": {
      const asString = typeof raw === "string" ? raw : String(raw);
      return {
        key: derivation.outputClaim,
        value: derivation.allowedValues.includes(asString),
      };
    }
  }
};

/**
 * Applies a result policy to the disclosed claims.
 *
 * The caller must invoke this in the same call stack that received the engine result
 * and must discard `disclosed` immediately afterwards. Nothing here retains a
 * reference to it, and the returned claims are a fresh object.
 */
export const applyResultPolicy = (
  policy: ResultPolicy,
  disclosed: DisclosedClaims,
  at: Date,
): ResultPolicyOutcome => {
  const claims: Record<string, unknown> = {};
  const unsatisfied: string[] = [];

  if (policy.kind === "VERIFIED_CLAIMS") {
    for (const path of policy.allowedClaims) {
      const value = readClaimAtPath(disclosed, path);
      if (value === undefined) {
        unsatisfied.push(`The allowed claim '${formatClaimPath(path)}' was not disclosed.`);
        continue;
      }
      const cleaned = stripUniqueElements(value);
      if (cleaned !== undefined) claims[formatClaimPath(path)] = cleaned;
    }
  } else {
    for (const derivation of policy.derivations) {
      const outcome = applyDerivation(derivation, disclosed, at);
      if ("unsatisfied" in outcome) {
        unsatisfied.push(outcome.unsatisfied);
        continue;
      }
      claims[outcome.key] = outcome.value;
    }
  }

  return {
    claims: Object.freeze(stripUniqueElements(claims) as NormalisedClaims),
    satisfied: unsatisfied.length === 0,
    unsatisfiedReasons: Object.freeze(unsatisfied),
  };
};

/**
 * Validates that a result policy only reads claims the policy version requested.
 *
 * A policy that derives from a claim it never asked the wallet for cannot work, and a
 * policy that returns a claim outside `requestedClaims` would bypass the registered
 * intended use. Both are rejected at publication time.
 */
export const findResultPolicyViolations = (
  policy: ResultPolicy,
  requested: readonly ClaimPath[],
): readonly string[] => {
  const allowed = new Set(requested.map(claimPathKey));
  const violations: string[] = [];
  for (const path of claimPathsReadBy(policy)) {
    if (!allowed.has(claimPathKey(path))) {
      violations.push(formatClaimPath(path));
    }
  }
  if (policy.kind === "DERIVED_CLAIMS") {
    const names = new Set<string>();
    for (const d of policy.derivations) {
      if (names.has(d.outputClaim)) {
        violations.push(`duplicate output claim '${d.outputClaim}'`);
      }
      names.add(d.outputClaim);
    }
  }
  return violations;
};
