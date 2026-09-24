import type { AuthenticSourceConnector, SourceAttributes } from "@edtp/domain";
import type { TransactionRepository } from "@edtp/persistence";
import { asId, type Clock, PlatformError } from "@edtp/shared";

/**
 * An authentic source whose subject is a presentation this platform has just verified.
 *
 * The demonstration it exists for: a person presents their PID, is identified, and is then issued an
 * attestation built from what they proved — here, a representative credential. `subjectReference`
 * is the **presentation id**, so it stays what the platform requires it to be, a lookup key and
 * never attribute values: the business client names a transaction, and the values come from the
 * verified result of that transaction. That is the legitimate form of the "attestation laundry"
 * concern the port guards against, not an exception to it.
 *
 * ## What it refuses
 *
 * - a presentation in **another tenant** — scoped by the `tenantId` the port now carries;
 * - a presentation that is not `VERIFIED`;
 * - a result the retention job has already purged;
 * - a result older than `maxAgeSeconds` (default 15 minutes), because "identified a moment ago" is
 *   the claim this source makes, and a day-old presentation does not make it.
 *
 * Each refusal names what is wrong and never the values involved.
 *
 * ## Why it is a FIXTURE, even though its identity attributes are verified
 *
 * The attributes that identify the person come from a verified presentation. The attributes that
 * make the attestation what it is — the organisation and the capacity in which the person may act
 * for it — come from **policy configuration** (`fixedClaims`), asserted by nobody authoritative.
 * An attestation of representation whose representation is invented is test data, whatever else
 * in it was verified, so the connector says so and every issuance through it carries the fixture
 * warning. A real source for representation is a company register, not a setting.
 *
 * ## Privacy
 *
 * It reads the **derived result** the platform already retains for the customer, within its
 * retention window — not content, which has no table. It returns only the claims the credential type
 * declares, so a PID presentation that disclosed more than the attestation needs contributes only
 * what it needs. The presentation id is kept as the issuance's `subjectReference`, which is what
 * makes the provenance of each attestation traceable afterwards.
 *
 * ## Parameters, from the policy version
 *
 *   {
 *     "claimsFromPresentation": { "<credential claim path>": "<result claim path>" },
 *     "fixedClaims":            { "<credential claim path>": "<value>" },
 *     "maxAgeSeconds":          900
 *   }
 *
 * A declared claim with no mapping is read from the result under the same path. A result claim path
 * may be dotted (`org.iso.18013.5.1.family_name` is read as nested when the flat key is absent).
 * A fixed value is any JSON value its claim's type accepts — for an `object[]` claim, the whole
 * array. Credential claim paths are dotted and the answer is built nested, as the type describes it.
 */
export class VerifiedPresentationConnector implements AuthenticSourceConnector {
  readonly name = "verified-presentation";
  readonly kind = "FIXTURE" as const;

  constructor(
    private readonly transactions: TransactionRepository,
    private readonly clock: Clock,
  ) {}

  async fetch(input: {
    readonly tenantId: string;
    readonly subjectReference: string;
    readonly requestedClaimPaths: readonly string[];
    readonly parameters: Readonly<Record<string, unknown>>;
  }): Promise<SourceAttributes | undefined> {
    if (!UUID.test(input.subjectReference)) {
      throw PlatformError.validation(
        "subject_reference_not_a_presentation",
        "This authentic source takes the id of a verified presentation as the subject reference.",
      );
    }

    const tenantId = asId<"TenantId">(input.tenantId);
    const presentationId = asId<"PresentationId">(input.subjectReference);

    // Tenant-scoped at the query: another tenant's presentation reads as not found, not as refused,
    // so this source cannot be used to probe whether an id exists elsewhere.
    const transaction = await this.transactions.find(tenantId, presentationId);
    if (!transaction) return undefined;

    if (transaction.state !== "VERIFIED") {
      throw PlatformError.conflict(
        "presentation_not_verified",
        `The presentation is ${transaction.state}, not VERIFIED. Only a verified presentation can ` +
          "be used to issue an attestation.",
      );
    }

    const result = await this.transactions.findResult(tenantId, presentationId);
    if (!result) {
      throw PlatformError.conflict(
        "presentation_result_unavailable",
        "The presentation's result is no longer retained. Ask the person to present again.",
      );
    }

    const maxAgeSeconds = positiveInteger(input.parameters["maxAgeSeconds"]) ?? 900;
    const ageSeconds = (this.clock.now().getTime() - result.createdAt.getTime()) / 1000;
    if (ageSeconds > maxAgeSeconds) {
      throw PlatformError.conflict(
        "presentation_too_old",
        `The presentation was verified more than ${maxAgeSeconds} seconds ago. Ask the person to ` +
          "present again.",
      );
    }

    const mapping = stringRecord(input.parameters["claimsFromPresentation"]);
    const fixed = plainRecord(input.parameters["fixedClaims"]);
    const claims = result.claims as Readonly<Record<string, unknown>>;

    // Nested, not keyed by the dotted path: the platform reads a source's answer by walking the
    // path, so a flat `"a.b"` key reads as absent. Until 23 September 2026 this returned flat keys,
    // which worked only because every type issued through it had one-segment paths.
    const attributes: Record<string, unknown> = {};
    for (const path of input.requestedClaimPaths) {
      const value = path in fixed ? fixed[path] : readPath(claims, mapping[path] ?? path);
      if (value !== undefined) writePath(attributes, path, value);
    }
    return attributes;
  }
}

const writePath = (target: Record<string, unknown>, path: string, value: unknown): void => {
  const segments = path.split(".");
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = value;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

const plainRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stringRecord = (value: unknown): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(plainRecord(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

/**
 * Reads a claim by path: the flat key first, then as nested segments.
 *
 * Both forms occur — an SD-JWT VC result is flat, an mdoc result is nested under its namespace
 * (`interop-findings.md` A24) — and an mdoc namespace itself contains dots, so a nested read tries
 * every split of the path rather than splitting on each dot.
 */
const readPath = (claims: Readonly<Record<string, unknown>>, path: string): unknown => {
  if (path in claims) return claims[path];
  const segments = path.split(".");
  for (let i = segments.length - 1; i > 0; i -= 1) {
    const head = segments.slice(0, i).join(".");
    const tail = segments.slice(i).join(".");
    const inner = claims[head];
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
      const value = readPath(inner as Record<string, unknown>, tail);
      if (value !== undefined) return value;
    }
  }
  return undefined;
};
