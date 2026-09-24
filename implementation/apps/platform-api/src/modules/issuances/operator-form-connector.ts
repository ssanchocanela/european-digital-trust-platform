import type { AuthenticSourceConnector, SourceAttributes } from "@edtp/domain";
import { PlatformError } from "@edtp/shared";

/**
 * An "authentic source" that is an operator typing values into a form. **Test data, by construction.**
 *
 * It exists for the test PID issuer: a PID this platform signs under its development PID Provider
 * CA, so a demonstration can start without the EUDI reference issuer. Nobody authoritative asserts
 * anything that passes through here — which is exactly what `FIXTURE` already means — so the kind is
 * `FIXTURE`, every issuance through it carries the fixture warning, and the issuance service accepts
 * it only under a `TEST` Attestation Provider (`assertSuppliedAttributesAllowed`).
 *
 * ## The rule it is the exception to
 *
 * `AuthenticSourceConnector` says a subject reference is a lookup key and never attribute values,
 * because a platform that issued whatever it was told would be an attestation laundry. This source
 * is that laundry, for synthetic data in `TEST`, and says so rather than disguising itself as a
 * lookup: `acceptsSuppliedAttributes` is the declared exception, and the service refuses supplied
 * values for every source without it.
 *
 * ## Privacy
 *
 * The values are content. They arrive in the request, are read here within one call stack, and go
 * to the engine's offer; nothing assigns them to a field, a row or a log line. The subject reference
 * is still required and is still what the transaction records — the console sends a random one.
 *
 * ## Parameters, from the policy version
 *
 *   { "fixedClaims": { "<credential claim path>": <value> } }
 *
 * Fixed claims are the Attestation Provider's to state — for a PID, `issuing_authority` and
 * `issuing_country` — so a supplied value for one is refused rather than silently overridden.
 */
export class OperatorFormConnector implements AuthenticSourceConnector {
  readonly name = "operator-form";
  readonly kind = "FIXTURE" as const;
  readonly acceptsSuppliedAttributes = true;

  async fetch(input: {
    readonly tenantId: string;
    readonly subjectReference: string;
    readonly requestedClaimPaths: readonly string[];
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly suppliedAttributes?: SourceAttributes;
  }): Promise<SourceAttributes | undefined> {
    const supplied = flatten(input.suppliedAttributes ?? {});
    const fixed = plainRecord(input.parameters["fixedClaims"]);

    // A key nobody asked for is most likely a typo for one somebody did. Dropping it silently, as
    // narrowing does for a real source's surplus, would issue a PID without the attribute the
    // operator believes they set. Names only in the message, never values.
    const requested = new Set(input.requestedClaimPaths);
    const undeclared = Object.keys(supplied).filter((path) => !requested.has(path));
    const overridden = Object.keys(supplied).filter((path) => path in fixed);
    if (undeclared.length > 0 || overridden.length > 0) {
      throw PlatformError.validation(
        "subject_attributes_invalid",
        "Some supplied attributes cannot be used.",
        [
          ...undeclared.map((path) => ({
            path,
            code: "subject_attribute_not_declared",
            message: `The credential type declares no attribute '${path}'.`,
          })),
          ...overridden.map((path) => ({
            path,
            code: "subject_attribute_fixed_by_policy",
            message: `'${path}' is set by the issuance policy and cannot be supplied.`,
          })),
        ],
      );
    }

    const attributes: Record<string, unknown> = {};
    for (const path of input.requestedClaimPaths) {
      const value = path in fixed ? fixed[path] : supplied[path];
      if (value !== undefined && value !== "") attributes[path] = value;
    }
    return nest(attributes);
  }
}

const plainRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * `{ place_of_birth: { country: "ES" } }` and `{ "place_of_birth.country": "ES" }` both become the
 * dotted form, so a caller may send either. Arrays are values, not structure.
 */
const flatten = (
  value: Readonly<Record<string, unknown>>,
  prefix = "",
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
      Object.assign(out, flatten(inner as Record<string, unknown>, path));
    } else {
      out[path] = inner;
    }
  }
  return out;
};

/** The shape `narrowToDeclaredClaims` reads: dotted paths as nested objects. */
const nest = (flat: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const segments = path.split(".");
    let cursor = out;
    for (const segment of segments.slice(0, -1)) {
      if (typeof cursor[segment] !== "object" || cursor[segment] === null) cursor[segment] = {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1] as string] = value;
  }
  return out;
};
