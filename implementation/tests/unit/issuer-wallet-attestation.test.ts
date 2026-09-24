import {
  compileIssuancePolicy,
  defaultRetentionPolicy,
  type IssuancePlan,
  type IssuancePolicyVersion,
  type ReusePolicy,
  validateIssuancePolicyVersion,
} from "@edtp/domain";
import type { EngineClient } from "@edtp/eudiplo-adapter";
import { EudiploIssuerAdapter } from "@edtp/eudiplo-adapter";
import { asId } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/**
 * What the issuer configuration and the credential configuration say to a wallet.
 *
 * Every assertion here is a line a real wallet refused on 16 September 2026, in order. They are
 * pinned on the body sent to the engine because the adapter writes the issuer configuration **whole**
 * (A20): a setting made directly on the engine is reverted by the next provisioning, and one was.
 * `interop-findings.md` A28.
 */

interface Call {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

const recordingClient = (calls: Call[]): EngineClient =>
  ({
    request: async (
      _ref: string,
      _method: string,
      path: string,
      body?: Record<string, unknown>,
    ) => {
      calls.push({ path, body: body ?? {} });
      return {} as never;
    },
  }) as unknown as EngineClient;

const at = new Date("2026-09-16T12:00:00Z");

const plan = (reusePolicy?: ReusePolicy): IssuancePlan => {
  const version: IssuancePolicyVersion = {
    ...(reusePolicy ? { reusePolicy } : {}),
    policyId: "policy-1",
    version: 1,
    status: "PUBLISHED",
    credentialTypeId: "type-1",
    purpose: [{ lang: "en", value: "Wallet attestation test" }],
    eligibilityRule: { evaluator: "AlwaysEligible", parameters: {} },
    authenticSource: { connector: "fixture", parameters: {} },
    holderBinding: "KEY_BOUND",
    flow: "PRE_AUTHORIZED_CODE",
    credentialValiditySeconds: 3_600,
    statusPolicy: { statusListEnabled: false, suspensionAllowed: false },
    retentionPolicy: defaultRetentionPolicy(),
    createdAt: at,
    publishedAt: at,
  };
  return compileIssuancePolicy({
    policyVersion: version,
    credentialType: {
      id: "type-1",
      tenantId: "11111111-1111-1111-1111-111111111111",
      attestationProviderId: "provider-1",
      name: "Employee badge",
      format: "dc+sd-jwt",
      vct: "urn:edtp:employee-badge:1",
      rulebook: {
        identifier: "urn:edtp:rulebook:badge",
        version: "1.0",
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
      display: [{ lang: "en", value: "Employee badge" }],
      validitySeconds: 86_400,
      statusMechanism: "NONE",
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
      signingKeyBindingRef: "key-1",
      engineTenantRef: "rpi-1",
      issuerDisplayName: "Test Organisation BV",
      eligibilityPresentations: [],
      requiresBuiltInAuthorizationServer: true,
    },
    at,
  });
};

const provision = async (
  options?: { walletProviderTrustListId?: string },
  reusePolicy?: ReusePolicy,
) => {
  const calls: Call[] = [];
  const adapter = new EudiploIssuerAdapter(recordingClient(calls), options);
  const p = plan(reusePolicy);
  await adapter.provisionCredentialConfiguration({
    engineTenantRef: p.providerContext.engineTenantRef,
    plan: p,
  });
  const issuer = calls.find((c) => c.path === "/issuer/config")?.body ?? {};
  const credential = calls.find((c) => c.path === "/issuer/credentials")?.body ?? {};
  return { issuer, credential };
};

describe("proof types a wallet's OpenID4VCI library will parse", () => {
  it("advertises the attestation proof type only", () =>
    provision().then(({ credential }) => {
      // Not `jwt`: Wallet Core 0.30.2 has no plain JWT proof — every JWT proof carries a key
      // attestation, which the engine resolves as signer method `custom` and refuses. An `attestation`
      // proof is verified by the engine against its wallet-provider trust list. The engine's default
      // `["attestation", "jwt"]` also fails the wallet's metadata parser. A29.
      const config = (credential.config ?? {}) as Record<string, unknown>;
      expect(config.proofTypesSupported).toEqual(["attestation"]);
    }));

  it("always carries a non-empty key_attestations_required", async () => {
    // Absent: "jwt proof must contain 'key_attestations_required'". `{}`: read as absent. An empty
    // key_storage: "keyStorage, if provided, must be non-empty". Only a non-empty list parses.
    const { credential } = await provision();
    const config = (credential.config ?? {}) as Record<string, unknown>;
    const required = config.keyAttestationsRequired as { key_storage?: readonly string[] };
    expect(required?.key_storage?.length).toBeGreaterThan(0);
    expect(required.key_storage).toEqual(["iso_18045_basic"]);
  });
});

describe("wallet attestation at the token endpoint", () => {
  it("is off, and says so, when no wallet-provider trust list is configured", async () => {
    const { issuer } = await provision();
    expect(issuer.walletAttestationRequired).toBe(false);
    expect(issuer.walletProviderTrustLists).toBeUndefined();
  });

  it("is required and names the engine trust list when one is configured", async () => {
    // The engine refuses a URL here and 401s on a list it does not hold, so it is referenced by id.
    const { issuer } = await provision({
      walletProviderTrustListId: "eudi-dev-wallet-providers",
    });
    expect(issuer.walletAttestationRequired).toBe(true);
    expect(issuer.walletProviderTrustLists).toEqual([
      { trustListId: "eudi-dev-wallet-providers" },
    ]);
  });
});

/**
 * How often one credential may be presented — the provider's policy, ARF `ISSU_38`, published as
 * `credential_reuse_policy` (`ISSU_50`). Without it the pinned wallet stores a PID as once-only and,
 * since the engine cannot serve it a batch (A34), as ONE once-only credential. The shape is pinned
 * because the wallet's library parses a known policy id strictly and a malformed option fails the
 * whole metadata document (A28).
 */
describe("credential_reuse_policy", () => {
  const limitedTime: ReusePolicy = { method: "LIMITED_TIME", reissueBeforeExpirySeconds: 600 };

  it("publishes nothing when the policy states nothing", async () => {
    const { credential } = await provision();
    const config = (credential.config ?? {}) as Record<string, unknown>;
    expect(config.credentialReusePolicy).toBeUndefined();
  });

  it("publishes Method B in the exact shape the wallet parses", async () => {
    const { credential } = await provision(undefined, limitedTime);
    const config = (credential.config ?? {}) as Record<string, unknown>;
    expect(config.credentialReusePolicy).toEqual({
      id: "arf_annex_ii",
      // Underscore: `eudi-lib-jvm-openid4vci-kt` 0.13.1 reads `limited_time`; the engine also takes
      // `limited-time`, which the wallet would refuse. Seconds, positive.
      options: [{ details: ["limited_time"], reissue_trigger_lifetime_left: 600 }],
    });
  });

  it("refuses a re-issuance lead that is not below the credential's validity", () => {
    const p = plan();
    const input = (lead: number) => ({
      credentialTypeId: "type-1",
      purpose: p.purpose,
      eligibilityRule: { evaluator: "AlwaysEligible", parameters: {} },
      authenticSource: { connector: "fixture", parameters: {} },
      holderBinding: "KEY_BOUND" as const,
      flow: "PRE_AUTHORIZED_CODE" as const,
      credentialValiditySeconds: 3_600,
      statusPolicy: { statusListEnabled: false, suspensionAllowed: false },
      retentionPolicy: defaultRetentionPolicy(),
      reusePolicy: { method: "LIMITED_TIME" as const, reissueBeforeExpirySeconds: lead },
    });
    const context = {
      credentialType: {
        id: "type-1",
        tenantId: "11111111-1111-1111-1111-111111111111",
        attestationProviderId: "provider-1",
        name: "Employee badge",
        format: "dc+sd-jwt" as const,
        vct: "urn:edtp:employee-badge:1",
        rulebook: {
          identifier: "urn:edtp:rulebook:badge",
          version: "1.0",
          anchorSource: "RULEBOOK_ONLY" as const,
        },
        claims: [],
        display: [{ lang: "en", value: "Employee badge" }],
        validitySeconds: 86_400,
        statusMechanism: "NONE" as const,
        requiresKeyBinding: true,
        createdAt: at,
      },
      registeredEvaluators: ["AlwaysEligible"],
      registeredConnectors: ["fixture"],
      at,
    };
    expect(() => validateIssuancePolicyVersion(input(600), context)).not.toThrow();
    for (const lead of [0, 3_600, 7_200]) {
      expect(() => validateIssuancePolicyVersion(input(lead), context)).toThrow();
    }
  });
});
