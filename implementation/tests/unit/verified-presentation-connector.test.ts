import type { TransactionRepository } from "@edtp/persistence";
import { VerifiedPresentationConnector } from "@edtp/platform-api/modules/issuances/verified-presentation-connector.js";
import { PlatformError } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/**
 * Issuing from a presentation the platform has just verified.
 *
 * The subject reference is a presentation id, supplied by a business client. So the refusals below
 * are the substance of the connector, and the one that matters most is the first: another tenant's
 * presentation must read as not found.
 */

const MINE = "11111111-1111-1111-1111-111111111111";
const THEIRS = "99999999-9999-9999-9999-999999999999";
const PRESENTATION = "22222222-2222-2222-2222-222222222222";
const NOW = new Date("2026-09-16T12:00:00Z");

const repo = (options: {
  readonly state?: string;
  readonly claims?: Record<string, unknown>;
  readonly verifiedSecondsAgo?: number;
  readonly resultPurged?: boolean;
}): TransactionRepository =>
  ({
    find: async (tenantId: string, id: string) =>
      tenantId === MINE && id === PRESENTATION
        ? { id, tenantId, state: options.state ?? "VERIFIED" }
        : undefined,
    findResult: async (tenantId: string, id: string) =>
      tenantId === MINE && id === PRESENTATION && !options.resultPurged
        ? {
            presentationId: id,
            tenantId,
            claims: options.claims ?? {
              family_name: "Perez",
              given_name: "Ana",
              birthdate: "1990-01-01",
            },
            createdAt: new Date(NOW.getTime() - (options.verifiedSecondsAgo ?? 60) * 1000),
            purgeAfter: new Date(NOW.getTime() + 86_400_000),
          }
        : undefined,
  }) as unknown as TransactionRepository;

const connector = (r: TransactionRepository) =>
  new VerifiedPresentationConnector(r, { now: () => NOW } as never);

const fetchFor = (
  c: VerifiedPresentationConnector,
  over: Partial<{
    tenantId: string;
    subjectReference: string;
    parameters: Record<string, unknown>;
  }> = {},
) =>
  c.fetch({
    tenantId: over.tenantId ?? MINE,
    subjectReference: over.subjectReference ?? PRESENTATION,
    requestedClaimPaths: ["family_name", "given_name", "legal_entity_name", "role"],
    parameters: over.parameters ?? {
      fixedClaims: { legal_entity_name: "Fictitious Company SL", role: "Legal representative" },
    },
  });

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return undefined;
  } catch (error) {
    return error instanceof PlatformError ? error.code : "not-a-platform-error";
  }
};

describe("verified-presentation authentic source", () => {
  it("builds the attestation from what was verified plus the fixed representation claims", async () => {
    const out = await fetchFor(connector(repo({})));
    expect(out).toEqual({
      family_name: "Perez",
      given_name: "Ana",
      legal_entity_name: "Fictitious Company SL",
      role: "Legal representative",
    });
  });

  it("returns only the declared claims — a PID that disclosed more contributes nothing extra", async () => {
    const out = await fetchFor(connector(repo({})));
    expect(out).not.toHaveProperty("birthdate");
  });

  it("reads another tenant's presentation as not found, never as refused", async () => {
    // Not found rather than an error that names it, so the source cannot probe whether an id exists.
    expect(await fetchFor(connector(repo({})), { tenantId: THEIRS })).toBeUndefined();
  });

  it("refuses a presentation that is not VERIFIED", async () => {
    expect(await codeOf(fetchFor(connector(repo({ state: "POLICY_NOT_SATISFIED" }))))).toBe(
      "presentation_not_verified",
    );
  });

  it("refuses when the result has been purged", async () => {
    expect(await codeOf(fetchFor(connector(repo({ resultPurged: true }))))).toBe(
      "presentation_result_unavailable",
    );
  });

  it("refuses a presentation verified too long ago", async () => {
    expect(await codeOf(fetchFor(connector(repo({ verifiedSecondsAgo: 3600 }))))).toBe(
      "presentation_too_old",
    );
  });

  it("takes a presentation id, not free text", async () => {
    expect(
      await codeOf(
        fetchFor(connector(repo({})), { subjectReference: "fixture-subject-adult" }),
      ),
    ).toBe("subject_reference_not_a_presentation");
  });

  it("maps credential claims to differently named result claims, including an mdoc namespace", async () => {
    const out = await connector(
      repo({ claims: { "org.iso.18013.5.1": { family_name: "Perez", given_name: "Ana" } } }),
    ).fetch({
      tenantId: MINE,
      subjectReference: PRESENTATION,
      requestedClaimPaths: ["representative_family_name", "given_name"],
      parameters: {
        claimsFromPresentation: {
          representative_family_name: "org.iso.18013.5.1.family_name",
          given_name: "org.iso.18013.5.1.given_name",
        },
      },
    });
    expect(out).toEqual({ representative_family_name: "Perez", given_name: "Ana" });
  });

  it("says it is a fixture, because the representation it attests is not from a register", () => {
    expect(connector(repo({})).kind).toBe("FIXTURE");
  });
});
