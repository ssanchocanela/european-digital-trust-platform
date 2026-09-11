import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import {
  compileIssuancePolicy,
  defaultRetentionPolicy,
  type IssuancePlan,
  type IssuancePolicyVersion,
} from "@edtp/domain";
import { EngineClient, EudiploIssuerAdapter } from "@edtp/eudiplo-adapter";
import { asId, systemClock } from "@edtp/shared";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Issuance contract against a **real engine container**, with the protocol artefacts decoded.
 *
 * The verification side proved the value of this: five defects, three of them in routes Phase 0 had
 * recorded from documentation. So this suite was written against the running container from the
 * start, and it decodes what a Wallet would actually receive rather than asserting that the platform
 * sent something.
 *
 * ## The two trust gates, tested separately because they are separate
 *
 * **Gate (a), ARF §6.6.2.2 — pre-issuance provider authentication.** A Wallet authenticates the
 * Attestation Provider *before* requesting a credential, from the Credential Issuer metadata. So the
 * test fetches the well-known document, unauthenticated, exactly as a Wallet does, and reports two
 * independent facts: whether the registration certificate is there (`issuer_info`) and whether the
 * metadata itself is signed (`signed_metadata`).
 *
 * **Gate (b), ARF §6.3.2.4 — attestation signature trust.** Anchors come from the Rulebook, and
 * optionally from an ETSI TS 119 602 list. What the adapter controls is whether the attestation
 * carries a chain a verifier can build a path from, which is the `x5c` choice asserted below.
 *
 * Skipped, like the other adapter suites, when no engine is reachable — and the skips say so.
 */
const baseUrl = process.env.ENGINE_BASE_URL;
const credentialsRaw = process.env.ENGINE_TENANT_CREDENTIALS;

let adapter: EudiploIssuerAdapter | undefined;
let reachable = false;
let engineTenantRef = "root";
let signingKeyBindingRef = "";
let testRegistrationCertificateJwt = "";

const decodeSegment = (segment: string): Record<string, unknown> => {
  const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
};

const at = new Date("2026-09-11T12:00:00Z");
const TENANT = "11111111-1111-1111-1111-111111111111";
const VCT = "urn:edtp:employee-badge:1";

const planFor = (registrationCertificateJwt?: string): IssuancePlan => {
  const version: IssuancePolicyVersion = {
    policyId: "issuance-contract-policy",
    version: 1,
    status: "PUBLISHED",
    credentialTypeId: "type-1",
    purpose: [{ lang: "en", value: "Issuance contract test" }],
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
      tenantId: TENANT,
      attestationProviderId: "provider-1",
      name: "Employee badge",
      format: "dc+sd-jwt",
      vct: VCT,
      rulebook: {
        identifier: "urn:edtp:rulebook:employee-badge",
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
      // The engine's status management is exercised separately; keeping it off here isolates the
      // offer path from the status-list path.
      statusMechanism: "NONE",
      requiresKeyBinding: true,
      createdAt: at,
    },
    attestationProvider: {
      id: "provider-1",
      tenantId: asId<"TenantId">(TENANT),
      organisationId: asId<"OrganisationId">("22222222-2222-2222-2222-222222222222"),
      registrarAssignedIdentifier: "NLAP.contract-test",
      trustEnvironment: "TEST",
      createdAt: at,
    },
    providerContext: {
      attestationProviderIdentifier: "NLAP.contract-test",
      ...(registrationCertificateJwt ? { registrationCertificateJwt } : {}),
      signingKeyBindingRef,
      engineTenantRef,
    },
    at,
  });
};

beforeAll(async () => {
  if (!baseUrl || !credentialsRaw) return;
  const eq = credentialsRaw.indexOf("=");
  const colon = credentialsRaw.indexOf(":", eq + 1);
  if (eq <= 0 || colon <= eq + 1) return;
  engineTenantRef = credentialsRaw.slice(0, eq);

  const client = new EngineClient({
    baseUrl,
    clock: systemClock,
    requestTimeoutMs: 20_000,
    credentials: {
      resolve: async (ref: string) => ({
        engineTenantRef: ref,
        clientId: credentialsRaw.slice(eq + 1, colon),
        clientSecret: credentialsRaw.slice(colon + 1),
      }),
    },
  });
  reachable = await client.health();
  if (!reachable) return;
  adapter = new EudiploIssuerAdapter(client);

  // The attestation-signing key. `usageType: "signing"`, not `"access"` — this signs attestations,
  // not presentation requests, and using the wrong usage type would put the key in the wrong role.
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const cert = execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-key",
      "/dev/stdin",
      "-days",
      "2",
      "-subj",
      "/CN=edtp-issuance-contract-test/O=Development only/C=EU",
    ],
    { input: pem },
  ).toString();
  const imported = await adapter.importSigningCertificate({
    engineTenantRef,
    name: "issuance contract test (development, self-signed)",
    privateKeyJwk: privateKey.export({ format: "jwk" }) as Record<string, unknown>,
    certificateChain: [cert],
  });
  signingKeyBindingRef = imported.keyBindingRef;

  // The TEST placeholder, minted by the same script the documentation points at.
  testRegistrationCertificateJwt = execFileSync(process.execPath, [
    join(__dirname, "..", "..", "scripts", "make-test-registration-certificate.mjs"),
    "--service",
    "NLAP.contract-test",
    "--vct",
    VCT,
    "--claim",
    "employee_id",
  ])
    .toString()
    .trim();
}, 120_000);

describe("issuance contract against a real engine (skipped when none is reachable)", () => {
  it("imports an attestation-signing key and returns an opaque reference", () => {
    if (!reachable) {
      console.info("[adapter-contract] issuance skipped: no engine reachable.");
      return;
    }
    expect(signingKeyBindingRef).toBeTruthy();
    expect(typeof signingKeyBindingRef).toBe("string");
  });

  it("provisions the issuance and credential configuration", async () => {
    if (!reachable || !adapter) return;
    // Two engine calls — `POST /api/issuer/config` then `POST /api/issuer/credentials`. Both must
    // be accepted, and the second is where `sdJwtTrustFormat: "x5c"` is set for trust gate (b).
    await expect(
      adapter.provisionCredentialConfiguration({ engineTenantRef, plan: planFor() }),
    ).resolves.toBeUndefined();
  }, 60_000);

  it("obtains a credential offer end to end, and reports the missing certificate", async () => {
    if (!reachable || !adapter) return;
    const plan = planFor();
    await adapter.provisionCredentialConfiguration({ engineTenantRef, plan });

    const offer = await adapter.createCredentialOffer({
      plan,
      // Attribute values. Passed through and never persisted by the platform.
      claims: { employee_id: "CONTRACT-TEST-0001" },
      sessionTtlSeconds: 300,
    });

    expect(offer.session.ref).toBeTruthy();
    expect(offer.session.engineTenantRef).toBe(engineTenantRef);
    // A wallet invocation URI; the platform treats it as opaque.
    expect(offer.uri).toMatch(/^[a-z][a-z0-9+.-]*:/i);
    // Blocker B3, reported rather than hidden.
    expect(offer.sentWithoutRegistrationCertificate).toBe(true);

    const status = await adapter.getIssuanceStatus(offer.session);
    // `active` must map to AWAITING_WALLET, not to a settled success.
    expect(status.progress).toBe("AWAITING_WALLET");
    expect(status.outcome).toBeUndefined();

    await adapter.cancelIssuance(offer.session);
  }, 60_000);

  it("decodes the credential offer as a wallet would, and finds the advertised configuration", async () => {
    if (!reachable || !adapter) return;
    const plan = planFor();
    await adapter.provisionCredentialConfiguration({ engineTenantRef, plan });
    const offer = await adapter.createCredentialOffer({
      plan,
      claims: { employee_id: "CONTRACT-TEST-0002" },
      sessionTtlSeconds: 300,
    });

    // A wallet resolves `credential_offer_uri`, or reads an inline `credential_offer`. Either way
    // what it ends up with names a credential configuration the issuer metadata must advertise.
    const url = new URL(
      offer.uri.replace(/^openid-credential-offer:\/\/\S*?\?/, "https://x/?"),
    );
    const offerUri = url.searchParams.get("credential_offer_uri");
    const inline = url.searchParams.get("credential_offer");
    expect(
      offerUri ?? inline,
      "the offer must carry an offer object or a URI to one",
    ).toBeTruthy();

    let configurationIds: string[] = [];
    if (offerUri) {
      const res = await fetch(offerUri);
      expect(res.ok, `credential_offer_uri returned ${res.status}`).toBe(true);
      const body = (await res.json()) as { credential_configuration_ids?: string[] };
      configurationIds = body.credential_configuration_ids ?? [];
    } else if (inline) {
      const body = JSON.parse(inline) as { credential_configuration_ids?: string[] };
      configurationIds = body.credential_configuration_ids ?? [];
    }
    expect(configurationIds.length).toBeGreaterThan(0);

    // And the metadata advertises the same configuration, or a wallet could not fulfil the offer.
    const evidence = await adapter.fetchProviderAuthenticationEvidence(engineTenantRef);
    for (const id of configurationIds) {
      expect(evidence.credentialConfigurationIds).toContain(id);
    }

    await adapter.cancelIssuance(offer.session);
  }, 60_000);

  it("reports gate (a) honestly: the metadata is NOT signed at this engine version", async () => {
    if (!reachable || !adapter) return;

    // Fetched unauthenticated from the well-known document, exactly as a Wallet does. The question
    // is what a Wallet receives, not what the platform configured — Milestone 1 found the engine
    // storing a registration certificate it then declined to publish.
    const evidence = await adapter.fetchProviderAuthenticationEvidence(engineTenantRef);
    expect(evidence.credentialIssuer).toContain(engineTenantRef);

    // `signed_metadata` is what lets a Wallet authenticate the metadata document itself, and the
    // pinned Reference Wallet requires it (`requireSignedMetadata()` →
    // `IssuerMetadataPolicy.RequireSigned`). EUDIPLO v7.6.0 has **zero** occurrences of the term in
    // its compiled source, so this asserts the gap rather than hoping it closed. If a later engine
    // release starts signing, this test fails and the documentation gets updated — which is the
    // outcome worth engineering for.
    expect(
      evidence.metadataSigned,
      "if this now passes, EUDIPLO has gained signed_metadata support: update docs/issuer-trust-model.md",
    ).toBe(false);
  }, 60_000);

  it("publishes the registration certificate in the metadata when one is held", async () => {
    if (!reachable || !adapter) return;

    // Gate (a)'s other half, which the engine *does* support: `issuer_info` carrying a
    // `registration_cert`. Provisioned with the TEST placeholder and then read back from the
    // well-known document.
    await adapter.provisionCredentialConfiguration({
      engineTenantRef,
      plan: planFor(testRegistrationCertificateJwt),
    });

    const evidence = await adapter.fetchProviderAuthenticationEvidence(engineTenantRef);
    expect(
      evidence.registrationCertificatePresent,
      "issuer_info must carry the registration certificate once one is configured",
    ).toBe(true);
    expect(evidence.registrationCertificateJwt).toBe(testRegistrationCertificateJwt);

    // It is a placeholder, and says so in its own issuer claim — so nothing downstream can mistake
    // this for evidence of conformance.
    const body = decodeSegment(
      (evidence.registrationCertificateJwt as string).split(".")[1] as string,
    );
    expect(body.iss).toBe("urn:edtp:TEST-PLACEHOLDER:NOT-ISSUED-BY-ANY-REGISTRAR");

    // Even with the certificate published, a Wallet still cannot fully authenticate the provider,
    // because the metadata is unsigned. Stated as a conjunction so neither half is forgotten.
    expect(evidence.registrationCertificatePresent && evidence.metadataSigned).toBe(false);
  }, 90_000);

  it("a deleted session surfaces as an engine error, not an invented outcome", async () => {
    if (!reachable || !adapter) return;
    const plan = planFor();
    await adapter.provisionCredentialConfiguration({ engineTenantRef, plan });
    const offer = await adapter.createCredentialOffer({
      plan,
      claims: { employee_id: "CONTRACT-TEST-0003" },
      sessionTtlSeconds: 300,
    });
    await adapter.cancelIssuance(offer.session);

    await expect(adapter.getIssuanceStatus(offer.session)).rejects.toMatchObject({
      kind: "ENGINE",
    });
  }, 60_000);
});
