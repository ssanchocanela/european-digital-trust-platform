import {
  type CredentialType,
  compileIssuancePolicy,
  defaultRetentionPolicy,
  type IssuancePlan,
  narrowToDeclaredClaims,
  validateCredentialType,
} from "@edtp/domain";
import type { EngineClient } from "@edtp/eudiplo-adapter";
import { EudiploIssuerAdapter } from "@edtp/eudiplo-adapter";
import type { TransactionRepository } from "@edtp/persistence";
import {
  assertPayloadSatisfiesSchema,
  compilePayloadSchema,
} from "@edtp/platform-api/modules/issuances/payload-schema.js";
import { VerifiedPresentationConnector } from "@edtp/platform-api/modules/issuances/verified-presentation-connector.js";
import { asId, PlatformError } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/**
 * Credential types with structure: nested claims, code lists, repeated groups, and rules between
 * claims.
 *
 * Written for the Power of X attestations, whose Rulebook stays outside the repository
 * (`docs/credential-catalogue.md`). So the shapes below are **synthetic** — an organisation, a
 * holder that is a person or an organisation, a list of mandates — chosen to exercise the same
 * mechanics without reproducing any of it.
 */

const at = new Date("2026-09-23T12:00:00Z");
const TENANT = "11111111-1111-1111-1111-111111111111";
const PRESENTATION = "22222222-2222-2222-2222-222222222222";

const text = (value: string) => [{ lang: "en", value }];

const claims: CredentialType["claims"] = [
  { path: ["Org", "Id"], display: text("Org id"), mandatory: true, valueType: "string" },
  { path: ["Holder", "Kind"], display: text("Kind"), mandatory: true, valueType: "integer" },
  {
    path: ["Person", "Family"],
    display: text("Family"),
    mandatory: false,
    valueType: "string",
  },
  {
    path: ["Person", "Countries"],
    display: text("Countries"),
    mandatory: false,
    valueType: "string[]",
  },
  { path: ["Entity", "Id"], display: text("Entity id"), mandatory: false, valueType: "string" },
  { path: ["Mandates"], display: text("Mandates"), mandatory: true, valueType: "object[]" },
];

/** Holder kind 1 is a person, 0 an entity; exactly the matching block; mandates with a code. */
const payloadSchema = {
  type: "object",
  required: ["Org", "Holder", "Mandates"],
  properties: {
    vct: { const: "urn:test:structured:1" },
    Holder: { type: "object", properties: { Kind: { enum: [0, 1] } } },
    Mandates: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["Code"],
        additionalProperties: false,
        properties: { Code: { type: "integer", minimum: 0, maximum: 30 } },
      },
    },
  },
  if: { properties: { Holder: { properties: { Kind: { const: 1 } } } } },
  // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, not a thenable.
  then: { required: ["Person"], not: { required: ["Entity"] } },
  else: { required: ["Entity"], not: { required: ["Person"] } },
};

const type: CredentialType = {
  id: "type-1",
  tenantId: TENANT,
  attestationProviderId: "provider-1",
  name: "Structured",
  format: "dc+sd-jwt",
  vct: "urn:test:structured:1",
  rulebook: { identifier: "urn:test:rulebook", version: "0.1", anchorSource: "RULEBOOK_ONLY" },
  claims,
  display: text("Structured"),
  validitySeconds: 86_400,
  statusMechanism: "TOKEN_STATUS_LIST",
  requiresKeyBinding: true,
  payloadSchema,
  createdAt: at,
};

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof PlatformError ? error.code : "not-a-platform-error";
  }
};

const detailsOf = (fn: () => unknown): readonly { path: string; code: string }[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PlatformError) return (error.details ?? []) as never;
  }
  return [];
};

describe("credential type validation, for structured types", () => {
  const base = {
    format: type.format,
    vct: type.vct,
    rulebook: type.rulebook,
    claims: type.claims,
    display: type.display,
    validitySeconds: type.validitySeconds,
    statusMechanism: type.statusMechanism,
  } as const;

  it("accepts integer and object[] claims and an object schema", () => {
    expect(codeOf(() => validateCredentialType({ ...base, payloadSchema }))).toBeUndefined();
  });

  it("refuses a claim path that is the prefix of another: a claim is a leaf", () => {
    const details = detailsOf(() =>
      validateCredentialType({
        ...base,
        claims: [
          ...claims,
          { path: ["Org"], display: text("Org"), mandatory: false, valueType: "string" },
        ],
      }),
    );
    expect(details.map((d) => d.code)).toContain("claim_path_prefixes_another");
  });

  it("refuses a payload schema that does not describe an object", () => {
    const details = detailsOf(() =>
      validateCredentialType({ ...base, payloadSchema: { type: "array" } }),
    );
    expect(details.map((d) => d.code)).toContain("payload_schema_not_object");
  });
});

describe("narrowing a source's answer, for the new value types", () => {
  const answer = {
    Org: { Id: "ORG-1" },
    Holder: { Kind: 1 },
    Person: { Family: "Tester", Countries: ["ES"] },
    Mandates: [{ Code: 9 }],
  };

  it("keeps nested, integer and object[] values", () => {
    expect(narrowToDeclaredClaims(answer, type)).toEqual(answer);
  });

  it("refuses a non-integer where an integer is declared", () => {
    const details = detailsOf(() =>
      narrowToDeclaredClaims({ ...answer, Holder: { Kind: 1.5 } }, type),
    );
    expect(details).toEqual([
      expect.objectContaining({ path: "Holder.Kind", code: "claim_type_mismatch" }),
    ]);
  });

  it("refuses an empty repeated group, and one whose elements are not objects", () => {
    for (const Mandates of [[], ["9"]]) {
      const details = detailsOf(() => narrowToDeclaredClaims({ ...answer, Mandates }, type));
      expect(details.map((d) => d.path)).toEqual(["Mandates"]);
    }
  });
});

describe("the payload schema, enforced on what would be issued", () => {
  const valid = {
    Org: { Id: "ORG-1" },
    Holder: { Kind: 1 },
    Person: { Family: "Tester" },
    Mandates: [{ Code: 9 }],
  };

  it("accepts claims that satisfy it", () => {
    expect(
      codeOf(() => assertPayloadSatisfiesSchema(payloadSchema, type.vct, valid)),
    ).toBeUndefined();
  });

  it("refuses both blocks at once, and the block that contradicts the declared kind", () => {
    const both = { ...valid, Entity: { Id: "E-1" } };
    const wrong = { ...valid, Holder: { Kind: 0 } };
    for (const claimsIn of [both, wrong]) {
      expect(
        codeOf(() => assertPayloadSatisfiesSchema(payloadSchema, type.vct, claimsIn)),
      ).toBe("credential_payload_invalid");
    }
  });

  it("checks inside a repeated group, and says where — never with the value", () => {
    const secret = 977_311;
    const details = detailsOf(() =>
      assertPayloadSatisfiesSchema(payloadSchema, type.vct, {
        ...valid,
        Mandates: [{ Code: 9 }, { Code: secret }],
      }),
    );
    expect(details).toContainEqual(
      expect.objectContaining({ path: "/Mandates/1/Code", code: "schema_maximum" }),
    );
    expect(JSON.stringify(details)).not.toContain(String(secret));
  });

  it("sees the vct, so one schema can tell a Rulebook's types apart", () => {
    expect(
      codeOf(() => assertPayloadSatisfiesSchema(payloadSchema, "urn:test:other:1", valid)),
    ).toBe("credential_payload_invalid");
  });

  it("refuses a schema that cannot be compiled when it is registered", () => {
    expect(codeOf(() => compilePayloadSchema({ type: "object", required: "Org" }))).toBe(
      "payload_schema_invalid",
    );
  });
});

describe("verified-presentation source, with nested credential paths", () => {
  const repo = {
    find: async (tenantId: string, id: string) =>
      tenantId === TENANT && id === PRESENTATION
        ? { id, tenantId, state: "VERIFIED" }
        : undefined,
    findResult: async (tenantId: string, id: string) =>
      tenantId === TENANT && id === PRESENTATION
        ? {
            presentationId: id,
            tenantId,
            claims: { family_name: "Tester", nationalities: ["ES"] },
            createdAt: new Date(at.getTime() - 60_000),
            purgeAfter: new Date(at.getTime() + 86_400_000),
          }
        : undefined,
  } as unknown as TransactionRepository;

  it("builds the structure the type describes, which the platform then accepts", async () => {
    const connector = new VerifiedPresentationConnector(repo, { now: () => at } as never);
    const out = await connector.fetch({
      tenantId: TENANT,
      subjectReference: PRESENTATION,
      requestedClaimPaths: claims.map((c) => c.path.join(".")),
      parameters: {
        claimsFromPresentation: {
          "Person.Family": "family_name",
          "Person.Countries": "nationalities",
        },
        fixedClaims: {
          "Org.Id": "ORG-1",
          "Holder.Kind": 1,
          Mandates: [{ Code: 9 }],
        },
      },
    });
    const expected = {
      Org: { Id: "ORG-1" },
      Holder: { Kind: 1 },
      Person: { Family: "Tester", Countries: ["ES"] },
      Mandates: [{ Code: 9 }],
    };
    expect(out).toEqual(expected);
    // The regression: flat "Person.Family" keys read as absent, so a mandatory nested claim failed.
    expect(narrowToDeclaredClaims(out ?? {}, type)).toEqual(expected);
  });
});

describe("the engine's credential configuration", () => {
  const plan = (): IssuancePlan =>
    compileIssuancePolicy({
      policyVersion: {
        policyId: "policy-1",
        version: 1,
        status: "PUBLISHED",
        credentialTypeId: "type-1",
        purpose: text("Structured test"),
        eligibilityRule: { evaluator: "AlwaysEligible", parameters: {} },
        authenticSource: { connector: "fixture", parameters: {} },
        holderBinding: "KEY_BOUND",
        flow: "PRE_AUTHORIZED_CODE",
        credentialValiditySeconds: 3_600,
        statusPolicy: { statusListEnabled: true, suspensionAllowed: false },
        retentionPolicy: defaultRetentionPolicy(),
        createdAt: at,
        publishedAt: at,
      },
      credentialType: type,
      attestationProvider: {
        id: "provider-1",
        tenantId: asId<"TenantId">(TENANT),
        organisationId: asId<"OrganisationId">("33333333-3333-3333-3333-333333333333"),
        registrarAssignedIdentifier: "NLAP.test",
        trustEnvironment: "TEST",
        createdAt: at,
      },
      providerContext: {
        attestationProviderIdentifier: "NLAP.test",
        signingKeyBindingRef: "key-1",
        engineTenantRef: "rpi-1",
        issuerDisplayName: "Test Organisation BV",
        eligibilityPresentations: [],
        requiresBuiltInAuthorizationServer: true,
      },
      at,
    });

  const fieldsSent = async (): Promise<readonly Record<string, unknown>[]> => {
    const bodies: Record<string, unknown>[] = [];
    const client = {
      request: async (
        _ref: string,
        _method: string,
        path: string,
        body?: Record<string, unknown>,
      ) => {
        if (path === "/issuer/credentials" && body) bodies.push(body);
        return {} as never;
      },
    } as unknown as EngineClient;
    const p = plan();
    await new EudiploIssuerAdapter(client).provisionCredentialConfiguration({
      engineTenantRef: p.providerContext.engineTenantRef,
      plan: p,
    });
    return (bodies[0]?.fields ?? []) as Record<string, unknown>[];
  };

  it("marks every claim selectively disclosable — the engine signs an unmarked one in the clear", async () => {
    const fields = await fieldsSent();
    expect(fields).toHaveLength(claims.length);
    for (const field of fields) expect(field.disclosable).toBe(true);
  });

  it("gives every field the engine's type", async () => {
    const byPath = Object.fromEntries(
      (await fieldsSent()).map((f) => [String(f.path), f.type]),
    );
    expect(byPath).toEqual({
      "Org,Id": "string",
      "Holder,Kind": "integer",
      "Person,Family": "string",
      "Person,Countries": "array",
      "Entity,Id": "string",
      Mandates: "array",
    });
  });
});
