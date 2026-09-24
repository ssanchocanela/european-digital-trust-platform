import { PlatformError } from "@edtp/shared";
import type { CredentialClaimDefinition, CredentialType } from "./credential-type.js";

/**
 * Attribute values fetched from an authentic source.
 *
 * **This is content.** It exists between the connector call and the engine call, inside one method,
 * and is never assigned to a field, persisted, queued or logged — the same discipline the
 * verification side applies to disclosed claims (ADR 0004).
 */
export type SourceAttributes = Readonly<Record<string, unknown>>;

/**
 * The port a connector implements.
 *
 * `subjectReference` is a **lookup key**, not attribute values: the business client tells the
 * platform *who* to ask about, and the platform asks the source. A client that could pass attribute
 * values directly would make the platform an attestation laundry, issuing claims nobody
 * authoritative asserted.
 */
export interface AuthenticSourceConnector {
  readonly name: string;
  /**
   * Whether this connector is a real authentic source or a stand-in.
   *
   * Not cosmetic. It is carried into the audit record and into the issuance result, so an
   * attestation issued from fixture data can never be mistaken for one issued from a real source.
   * V0 ships only `FIXTURE`.
   */
  readonly kind: "REAL" | "FIXTURE";
  fetch(input: {
    readonly subjectReference: string;
    /** Exactly the claim paths the credential type declares. Minimisation at the source. */
    readonly requestedClaimPaths: readonly string[];
    readonly parameters: Readonly<Record<string, unknown>>;
  }): Promise<SourceAttributes | undefined>;
}

/**
 * The eligibility decision.
 *
 * A `reason` is required on refusal and must be safe to return to the business client: it explains
 * the decision without restating the attribute values that drove it.
 */
export interface EligibilityDecision {
  readonly eligible: boolean;
  readonly reason?: string;
}

export interface EligibilityEvaluator {
  readonly name: string;
  evaluate(input: {
    readonly attributes: SourceAttributes;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly at: Date;
  }): EligibilityDecision;
}

/**
 * Reads a claim path out of a source response.
 *
 * Paths are dotted strings here rather than arrays, because that is what a connector contract is
 * naturally expressed in; the domain's canonical form stays the array, and `declaredClaimPaths`
 * does the conversion in one place.
 */
const readPath = (attributes: SourceAttributes, path: string): unknown => {
  let cursor: unknown = attributes;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};

const matchesType = (
  value: unknown,
  valueType: CredentialClaimDefinition["valueType"],
): boolean => {
  switch (valueType) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      // ISO 8601 date or date-time. Strict enough to catch a source returning a locale format,
      // which is the realistic failure, without reimplementing a date parser.
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T|$)/.test(value);
  }
};

/**
 * Validates a source response against the credential type, and narrows it to the declared claims.
 *
 * Three things happen here, and each prevents a specific bad outcome:
 *
 * 1. **A missing mandatory claim is a refusal**, not a partially-populated attestation. Issuing an
 *    attestation that omits a claim its type declares mandatory would make the type a lie.
 * 2. **A wrong type is a refusal.** A source returning `"42"` where a number is declared would
 *    otherwise produce an attestation whose claim does not match its own schema.
 * 3. **Undeclared attributes are dropped.** A source that returns more than it was asked is
 *    common, and passing the surplus to the engine would put it in the attestation — the exact
 *    over-issuance that minimisation at the source exists to prevent. Dropping is silent by
 *    design: it is the source's business what it returns, and the platform's business what it uses.
 *
 * The error carries claim **paths**, never values.
 */
export const narrowToDeclaredClaims = (
  attributes: SourceAttributes,
  credentialType: CredentialType,
): SourceAttributes => {
  const details: { path: string; code: string; message: string }[] = [];
  const narrowed: Record<string, unknown> = {};

  for (const claim of credentialType.claims) {
    const path = claim.path.join(".");
    const value = readPath(attributes, path);

    if (value === undefined || value === null) {
      if (claim.mandatory) {
        details.push({
          path,
          code: "mandatory_claim_missing",
          message: `The authentic source returned no value for mandatory claim '${path}'.`,
        });
      }
      continue;
    }

    if (!matchesType(value, claim.valueType)) {
      details.push({
        path,
        code: "claim_type_mismatch",
        message: `Claim '${path}' is declared as ${claim.valueType} but the source returned a different type.`,
      });
      continue;
    }

    // Rebuild nested structure rather than flattening, so the engine receives the shape the
    // credential type describes.
    let cursor = narrowed;
    for (const segment of claim.path.slice(0, -1)) {
      const next = cursor[segment];
      if (typeof next !== "object" || next === null) cursor[segment] = {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[claim.path[claim.path.length - 1] as string] = value;
  }

  if (details.length > 0) {
    throw PlatformError.unprocessable(
      "authentic_source_response_invalid",
      "The authentic source's response does not satisfy the credential type.",
      details,
    );
  }

  return narrowed;
};
