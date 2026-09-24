import { compileIssuancePolicy, defaultRetentionPolicy, type IssuancePlan } from "@edtp/domain";
import type { EngineClient } from "@edtp/eudiplo-adapter";
import { EudiploIssuerAdapter } from "@edtp/eudiplo-adapter";
import { asId } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/**
 * Which key signs the tenant's status lists — `interop-findings.md` A33.
 *
 * A status list created without a key chain is signed with whatever the engine finds, which in
 * practice was the tenant's oldest attestation key. On `rpi-1` that key expired on 15 September 2026
 * and every strict status check failed from then on. The adapter now pins the tenant's shared lists
 * to the provider's own attestation key whenever it provisions a credential configuration.
 */

const at = new Date("2026-09-23T12:00:00Z");
const KEY = "provider-attestation-key";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
}

const run = async (options: {
  readonly lists: readonly Record<string, unknown>[];
  readonly statusListEnabled?: boolean;
}): Promise<readonly Call[]> => {
  const calls: Call[] = [];
  const client = {
    request: async (
      _ref: string,
      method: string,
      path: string,
      body?: Record<string, unknown>,
    ) => {
      calls.push({ method, path, ...(body ? { body } : {}) });
      return (path === "/status-lists" && method === "GET" ? options.lists : {}) as never;
    },
  } as unknown as EngineClient;
  const p = plan(options.statusListEnabled ?? true);
  await new EudiploIssuerAdapter(client).provisionCredentialConfiguration({
    engineTenantRef: p.providerContext.engineTenantRef,
    plan: p,
  });
  return calls.filter((c) => c.path.startsWith("/status-lists"));
};

describe("pinning the status list signing key to the provider's attestation key", () => {
  it("creates a pinned shared list when the tenant has none", async () => {
    const calls = await run({ lists: [] });
    expect(calls).toContainEqual({
      method: "POST",
      path: "/status-lists",
      body: { keyChainId: KEY },
    });
  });

  it("re-pins a shared list signed with another key, and leaves a pinned one alone", async () => {
    const calls = await run({
      lists: [
        { id: "shared-unpinned", credentialConfigurationId: null, keyChainId: null },
        { id: "shared-other", credentialConfigurationId: null, keyChainId: "old-smoke-key" },
        { id: "shared-ok", credentialConfigurationId: null, keyChainId: KEY },
      ],
    });
    const patched = calls.filter((c) => c.method === "PATCH").map((c) => c.path);
    expect(patched).toEqual(["/status-lists/shared-unpinned", "/status-lists/shared-other"]);
    expect(
      calls.filter((c) => c.method === "PATCH").every((c) => c.body?.keyChainId === KEY),
    ).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("does not touch a list bound to one credential configuration", async () => {
    const calls = await run({
      lists: [{ id: "dedicated", credentialConfigurationId: "c-other-v1", keyChainId: "k" }],
    });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("does nothing when the policy issues without a status list", async () => {
    expect(await run({ lists: [], statusListEnabled: false })).toEqual([]);
  });
});

const plan = (statusListEnabled: boolean): IssuancePlan =>
  compileIssuancePolicy({
    policyVersion: {
      policyId: "policy-1",
      version: 1,
      status: "PUBLISHED",
      credentialTypeId: "type-1",
      purpose: [{ lang: "en", value: "Status list key test" }],
      eligibilityRule: { evaluator: "AlwaysEligible", parameters: {} },
      authenticSource: { connector: "fixture", parameters: {} },
      holderBinding: "KEY_BOUND",
      flow: "PRE_AUTHORIZED_CODE",
      credentialValiditySeconds: 3_600,
      statusPolicy: { statusListEnabled, suspensionAllowed: false },
      retentionPolicy: defaultRetentionPolicy(),
      createdAt: at,
      publishedAt: at,
    },
    credentialType: {
      id: "type-1",
      tenantId: "11111111-1111-1111-1111-111111111111",
      attestationProviderId: "provider-1",
      name: "Badge",
      format: "dc+sd-jwt",
      vct: "urn:test:badge:1",
      rulebook: {
        identifier: "urn:test:rulebook",
        version: "1",
        anchorSource: "RULEBOOK_ONLY",
      },
      claims: [
        {
          path: ["employee_id"],
          display: [{ lang: "en", value: "Employee number" }],
          mandatory: true,
          valueType: "string",
        },
      ],
      display: [{ lang: "en", value: "Badge" }],
      validitySeconds: 86_400,
      statusMechanism: statusListEnabled ? "TOKEN_STATUS_LIST" : "NONE",
      requiresKeyBinding: true,
      createdAt: at,
    },
    attestationProvider: {
      id: "provider-1",
      tenantId: asId<"TenantId">("11111111-1111-1111-1111-111111111111"),
      organisationId: asId<"OrganisationId">("22222222-2222-2222-2222-222222222222"),
      registrarAssignedIdentifier: "NLAP.test",
      trustEnvironment: "TEST",
      createdAt: at,
    },
    providerContext: {
      attestationProviderIdentifier: "NLAP.test",
      signingKeyBindingRef: KEY,
      engineTenantRef: "rpi-1",
      issuerDisplayName: "Test Organisation BV",
      eligibilityPresentations: [],
      requiresBuiltInAuthorizationServer: true,
    },
    at,
  });
