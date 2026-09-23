import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import {
  compileIssuancePolicy,
  defaultRetentionPolicy,
  type EligibilityPresentation,
  type IssuancePlan,
  type IssuancePolicyVersion,
  type VerificationPlan,
} from "@edtp/domain";
import {
  EngineClient,
  EudiploIssuerAdapter,
  presentationConfigId,
} from "@edtp/eudiplo-adapter";
import { asId, systemClock } from "@edtp/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { selfSignedCertificate } from "../support/self-signed.js";

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
 * test fetches the well-known document, unauthenticated, exactly as a Wallet does.
 *
 * Gate (a) is **one mechanism, not two halves** — an earlier version of this comment had that wrong.
 * ETSI TS 119 472-3 V1.1.1 routes all of it through a single JWS: the metadata is signed
 * (`ISS-MDATA-4.2.1-01`) by the provider's access certificate (`-02`), which travels in the `x5c`
 * protected header (`ISS-MDATA-ACC_CERT-4.2.2-01/-02`), with `issuer_info` at the top level of the
 * signed payload (`ISS-MDATA-REG_CERT-4.2.3-02`). So the test reports four facts and asserts each
 * separately, so that a release adding the signature without the certificate cannot read as a closed
 * gate.
 *
 * **Gate (b), ARF §6.3.2.4 — attestation signature trust.** Anchors come from the Rulebook, and
 * optionally from an ETSI TS 119 602 list. What the adapter controls is whether the attestation
 * carries a chain a verifier can build a path from, which is the `x5c` choice asserted below.
 *
 * Skipped, like the other adapter suites, when no engine is reachable — and the skips say so.
 */
const baseUrl = process.env.ENGINE_BASE_URL;

/**
 * A gating presentation policy, for the A20 tests.
 *
 * Synthetic, and that is sound here only because of a fact this suite established on 13 September
 * 2026: `POST /issuer/config` does **not** check that `presentationConfigId` names a configuration
 * that exists — a nonexistent one is accepted with `201` and fails much later, when a Wallet reaches
 * the authorization step. Recorded as `interop-findings.md` A21. So these tests can assert what the
 * metadata advertises without provisioning a verifier configuration first, and the id below is
 * deliberately one that resolves to nothing.
 */
const ELIGIBILITY_POLICY_ID = "00000000-0000-4000-8000-00000000a20a";

/**
 * The issuer trust list the eligibility presentation names. The adapter refuses to write a
 * presentation configuration whose list is not loaded on the engine tenant (A30), so the suite
 * needs one loaded — `scripts/load-issuer-trust-list.mjs`, with the id below.
 */
const CONTRACT_PID_LIST = {
  ref: "https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/PIDProviders.jwt",
  id: process.env.CONTRACT_PID_TRUST_LIST_ID ?? "eudi-dev-pid-providers",
};

/**
 * The eligibility presentation the issuer will write on its **own** engine tenant.
 *
 * Content only — a credential requirement, claims, a status-check mode. No Relying Party context,
 * because in this exchange the issuer is the Relying Party: `interop-findings.md` A22.
 */
const eligibilityFor = (policyId: string): EligibilityPresentation => ({
  policyId,
  policyVersion: 1,
  credentialRequirement: {
    credentialType: "urn:eudi:pid:1",
    acceptedFormats: ["dc+sd-jwt"],
    vctValues: ["urn:eudi:pid:1"],
  },
  requestedClaims: [{ path: ["birthdate"] }],
  statusCheckMode: "STRICT",
  anchorSources: [
    { kind: "ETSI_TS_119_602_LOTE", domain: "PID_PROVIDER", ref: CONTRACT_PID_LIST.ref },
  ],
});
const credentialsRaw = process.env.ENGINE_TENANT_CREDENTIALS;

let adapter: EudiploIssuerAdapter | undefined;
let client: EngineClient | undefined;
let reachable = false;
let engineTenantRef = "root";
let signingKeyBindingRef = "";
let testRegistrationCertificateJwt = "";
/**
 * A separate **access**-usage key chain for the nested presentation request.
 *
 * Deliberately not the attestation key: a presentation request is authenticated with an access
 * certificate, and reusing the attestation-signing key would put one key in two roles — the same
 * separation `assertTrustListSigningKey` enforces for published trust lists.
 */
let accessKeyBindingRefForPresentation = "";

const decodeSegment = (segment: string): Record<string, unknown> => {
  const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
};

const at = new Date("2026-09-11T12:00:00Z");
const TENANT = "11111111-1111-1111-1111-111111111111";
const VCT = "urn:edtp:employee-badge:1";

/**
 * @param over  Overrides for the provider-scoped part of the plan. `registrationCertificateJwt`
 *              stays positional-compatible via the first field, because most call sites want only
 *              that; the rest exist for the A20 tests, where the point *is* that the engine's issuer
 *              configuration describes the provider rather than this one credential type.
 */
const planFor = (
  registrationCertificateJwt?: string,
  over?: {
    readonly issuerDisplayName?: string;
    readonly eligibilityPresentations?: readonly EligibilityPresentation[];
    readonly accessKeyBindingRef?: string;
    readonly requiresBuiltInAuthorizationServer?: boolean;
  },
): IssuancePlan => {
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
      issuerDisplayName: over?.issuerDisplayName ?? "Contract Test Organisation BV",
      eligibilityPresentations: over?.eligibilityPresentations ?? [],
      ...(over?.accessKeyBindingRef ? { accessKeyBindingRef: over.accessKeyBindingRef } : {}),
      requiresBuiltInAuthorizationServer: over?.requiresBuiltInAuthorizationServer ?? true,
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

  client = new EngineClient({
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
  adapter = new EudiploIssuerAdapter(client, {
    issuerTrustLists: { [CONTRACT_PID_LIST.ref]: CONTRACT_PID_LIST.id },
  });

  // The attestation-signing key. `usageType: "signing"`, not `"access"` — this signs attestations,
  // not presentation requests, and using the wrong usage type would put the key in the wrong role.
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const cert = selfSignedCertificate(pem, "edtp-issuance-contract-test");
  const imported = await adapter.importSigningCertificate({
    engineTenantRef,
    name: "issuance contract test (development, self-signed)",
    privateKeyJwk: privateKey.export({ format: "jwk" }) as Record<string, unknown>,
    certificateChain: [cert],
  });
  signingKeyBindingRef = imported.keyBindingRef;

  // A distinct access-usage chain for the nested presentation request.
  const { privateKey: accessKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const accessPem = accessKey.export({ type: "pkcs8", format: "pem" }).toString();
  const accessCert = selfSignedCertificate(accessPem, "edtp-issuance-contract-access");
  const accessImported = await client.request<{ id: string }>(
    engineTenantRef,
    "POST",
    "/key-chain/import",
    {
      key: accessKey.export({ format: "jwk" }),
      usageType: "access",
      description: "issuance contract test, nested presentation (development, self-signed)",
      crt: [accessCert],
    },
  );
  accessKeyBindingRefForPresentation = accessImported.id;

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

  it("stores every claim as selectively disclosable, with a type — A32", async () => {
    if (!reachable || !adapter || !client) return;
    const plan = planFor();
    await adapter.provisionCredentialConfiguration({ engineTenantRef, plan });

    // Read back, because the engine's field schema is lenient: a field sent without `disclosable`
    // was accepted for weeks and signed in the clear. What it stored is what it will sign with.
    const configs = (await client.request(engineTenantRef, "GET", "/issuer/credentials")) as {
      readonly description?: string;
      readonly fields?: readonly Record<string, unknown>[];
    }[];
    const mine = configs.find((c) =>
      c.description?.includes(`policy ${plan.policyId} v${plan.policyVersion}`),
    );
    expect(mine?.fields).toEqual([
      expect.objectContaining({ path: ["employee_id"], type: "string", disclosable: true }),
    ]);
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

    // And the two things the signature is the carrier for, per ETSI TS 119 472-3 V1.1.1: the access
    // certificate in the `x5c` protected header (`ISS-MDATA-ACC_CERT-4.2.2-01/-02`) and the
    // registration certificate inside the signed payload (`ISS-MDATA-REG_CERT-4.2.3-02`). Both are
    // necessarily false while there is no signature, and both are asserted separately so a release
    // that adds signing without the access certificate cannot look like a closed gate.
    expect(
      evidence.accessCertificateInSignedMetadata,
      "signed metadata now carries x5c: gap G8 may be closed — re-read docs/eudiplo-integration.md §10B",
    ).toBe(false);
    expect(
      evidence.registrationCertificateInSignedPayload,
      "issuer_info is now inside the signed payload: re-read the G2 placement note in §10B",
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

    // Even with the certificate published, a Wallet still cannot authenticate the provider, because
    // the metadata is unsigned — and because `ISS-MDATA-REG_CERT-4.2.3-02` wants this certificate at
    // the top level of the *signed* payload, not in the unsigned document where it sits. So what this
    // test verifies is that the engine publishes it somewhere readable, which is not the same as
    // publishing it conformantly.
    expect(evidence.registrationCertificateInSignedPayload).toBe(false);
    expect(
      evidence.metadataSigned &&
        evidence.accessCertificateInSignedMetadata &&
        evidence.registrationCertificateInSignedPayload,
    ).toBe(false);
  }, 90_000);

  it("PID-during-issuance: the nested presentation request is decodable, as far as a wallet would get", async () => {
    if (!reachable || !adapter) return;

    // The §7.3 stretch goal. The engine exposes it as an `oid4vp` authorization server that names a
    // presentation configuration, so the issuance's authorization step *is* an OpenID4VP exchange.
    //
    // No wallet is involved, so what can be checked is everything up to the point a wallet would
    // take over: that the nested presentation configuration exists, that the engine serves a signed
    // request object for it, and that the request object carries the DCQL, the certificate chain and
    // the registration-certificate claim the verification side already asserts. Past that point —
    // the wallet responding — needs a wallet, and this test says so rather than pretending.
    const presentationPolicyId = `pid-eligibility-${Date.now()}`;
    const presentationConfigId = `p-${presentationPolicyId}-v1`;

    // The nested presentation configuration, created directly: the platform's verifier adapter does
    // this from a verification policy, and reusing one is the point of the feature.
    // Narrowed once rather than asserted at each use: the guard above already established it.
    const engine = client;
    if (!engine) return;

    await engine.request(engineTenantRef, "POST", "/verifier/config", {
      id: presentationConfigId,
      dcql_query: {
        credentials: [
          {
            id: "pid",
            format: "dc+sd-jwt",
            meta: { vct_values: ["urn:eudi:pid:1"] },
            claims: [{ path: ["birthdate"] }],
          },
        ],
      },
      accessKeyChainId: accessKeyBindingRefForPresentation,
    });

    // An offer whose authorization step is that presentation.
    const plan = {
      ...planFor(),
      eligibilityPresentationPolicyId: presentationPolicyId,
    } as IssuancePlan;
    await adapter.provisionCredentialConfiguration({ engineTenantRef, plan });

    // The engine serves the nested request object at the presentation session's own endpoint, so the
    // decodable artefact is reached through the presentation configuration rather than the offer.
    const offer = await engine.request<{ uri: string; session: string }>(
      engineTenantRef,
      "POST",
      "/verifier/offer",
      { response_type: "uri", requestId: presentationConfigId },
    );
    const requestUri = new URL(
      offer.uri.replace(/^openid4vp:\/\//, "https://placeholder/"),
    ).searchParams.get("request_uri");
    expect(requestUri, "the nested presentation must expose a request_uri").toBeTruthy();

    const res = await fetch(requestUri as string);
    expect(res.ok).toBe(true);
    const payload = decodeSegment((await res.text()).trim().split(".")[1] as string);

    // What a wallet would read, and what the platform therefore has to get right:
    expect(payload.response_type).toBe("vp_token");
    expect(String(payload.client_id)).toMatch(/^x509_hash:/);
    expect(payload.response_mode).toBe("direct_post.jwt");
    expect(payload.nonce).toBeTruthy();

    // The DCQL asks for the PID date of birth — the eligibility input — and nothing more.
    const dcql = payload.dcql_query as { credentials?: { meta?: { vct_values?: string[] } }[] };
    expect(dcql.credentials?.[0]?.meta?.vct_values).toEqual(["urn:eudi:pid:1"]);
    expect(JSON.stringify(dcql)).toContain("birthdate");

    // The certificate chain is present, so a wallet could authenticate the requester.
    const header = decodeSegment(
      (await (await fetch(requestUri as string)).text()).trim().split(".")[0] as string,
    );
    expect(Array.isArray(header.x5c)).toBe(true);

    // And the registration certificate is absent, for the same engine reason as the verification
    // side: `verifier_info` needs a configured registrar. This is the inheritance the documentation
    // warns about — enabling PID-during-issuance makes the issuer a Relying Party, and it inherits
    // `RPRC_19`'s limitation rather than escaping it.
    expect(payload.verifier_info).toBeUndefined();

    // What cannot be checked without a wallet, stated rather than skipped silently.
    console.info(
      "[adapter-contract] PID-during-issuance: request object verified as far as a wallet would " +
        "read it. The wallet response, the eligibility decision and the resulting issuance remain " +
        "UNVERIFIED (blocker B7).",
    );
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

  /**
   * `interop-findings.md` A20, against the engine that produced it.
   *
   * `POST /issuer/config` is tenant-scoped. The adapter used to compose it from the credential type
   * being provisioned, so provisioning a PID-gated type left the tenant advertising only its
   * `oid4vp` server and an ordinary type left only `built-in` — while offers for the other kind went
   * on naming a server the metadata no longer listed. A Wallet checking an offer's
   * `authorization_server` against the issuer metadata, which OpenID4VCI expects where more than one
   * exists, would refuse an offer the engine was willing to honour.
   *
   * These read the **Wallet-facing** metadata rather than the management API, because that document
   * is what the defect was invisible in and what a Wallet actually reads.
   */
  const issuerMetadata = async (): Promise<Record<string, unknown>> => {
    const response = await fetch(
      `${baseUrl}/.well-known/openid-credential-issuer/issuers/${engineTenantRef}`,
    );
    return (await response.json()) as Record<string, unknown>;
  };

  it("advertises every authorization server the provider needs, not the last one provisioned", async () => {
    if (!reachable || !adapter) return;
    await adapter.provisionCredentialConfiguration({
      engineTenantRef,
      plan: planFor(undefined, {
        eligibilityPresentations: [eligibilityFor(ELIGIBILITY_POLICY_ID)],
        accessKeyBindingRef: accessKeyBindingRefForPresentation,
        requiresBuiltInAuthorizationServer: true,
      }),
    });

    const metadata = await issuerMetadata();
    const list = metadata.authorization_servers as string[];
    expect(Array.isArray(list)).toBe(true);
    // Compared against the engine's own `credential_issuer`, not against `ENGINE_BASE_URL`: the
    // engine emits its configured public URL, which is not necessarily the host the test connects
    // on. The built-in server is advertised as the issuer's own URL; the gated one gets a path
    // under it.
    const issuer = metadata.credential_issuer as string;
    expect(list).toContain(issuer);
    expect(list).toContain(
      `${issuer}/authorization-servers/eligibility-${ELIGIBILITY_POLICY_ID}`,
    );
    // Both, which is the whole of A20: before the fix this list held exactly one.
    expect(list).toHaveLength(2);
  }, 60_000);

  it("writes the eligibility presentation configuration on the issuer's own engine tenant", async () => {
    if (!reachable || !adapter || !client) return;
    // A22. It used to be referenced and never written: the verifier adapter creates presentation
    // configurations lazily, at the first presentation, on the *Relying Party Instance's* tenant.
    // This asserts the configuration exists on the **issuer's** tenant after provisioning alone,
    // with no presentation ever having been created — which is the state a gated issuance is in.
    const policyId = "00000000-0000-4000-8000-00000000a22a";
    await adapter.provisionCredentialConfiguration({
      engineTenantRef,
      plan: planFor(undefined, {
        eligibilityPresentations: [eligibilityFor(policyId)],
        accessKeyBindingRef: accessKeyBindingRefForPresentation,
        requiresBuiltInAuthorizationServer: false,
      }),
    });

    const configs = await client.request<{ id: string; accessKeyChainId?: string }[]>(
      engineTenantRef,
      "GET",
      "/verifier/config",
    );
    const written = configs.find((c) => c.id === `elig-p-${policyId}-v1`);
    expect(written).toBeDefined();
    // Namespaced away from the verifier adapter's id. The two write the same engine endpoint, and on
    // a tenant serving both roles they would fight over one object with different access keys —
    // observed on the running stack, `interop-findings.md` A23.
    //
    // Asserted as a property of the two id functions rather than as the absence of a `p-…` config on
    // the tenant: the engine keeps whatever earlier runs wrote, so an absence assertion would pass
    // or fail on leftovers instead of on the code.
    expect(written?.id).not.toBe(
      presentationConfigId({ policyId, policyVersion: 1 } as unknown as VerificationPlan),
    );
    // Signed with the **provider's** access certificate, not a Relying Party's. Reusing a
    // verification policy means reusing its content, not another party's credentials.
    expect(written?.accessKeyChainId).toBe(accessKeyBindingRefForPresentation);
  }, 60_000);

  it("refuses a gating policy when the provider has no access certificate of its own", async () => {
    if (!reachable || !adapter) return;
    // Without one the request object would be unsigned or signed by the wrong party, and a Wallet
    // accepts only an access certificate chaining to a notified anchor (`AS-WP-06-005` / `RPA_04`).
    // The failure belongs here, not on the phone.
    await expect(
      adapter.provisionCredentialConfiguration({
        engineTenantRef,
        plan: planFor(undefined, {
          eligibilityPresentations: [eligibilityFor(ELIGIBILITY_POLICY_ID)],
          requiresBuiltInAuthorizationServer: true,
        }),
      }),
    ).rejects.toMatchObject({ code: "attestation_provider_has_no_access_certificate" });
  }, 60_000);

  it("names the Credential Issuer after the organisation, not after a credential", async () => {
    if (!reachable || !adapter) return;
    // The display written here is the *issuer's*. Composing it from the credential type made the
    // metadata announce a Wallet-visible issuer called "Employee badge".
    await adapter.provisionCredentialConfiguration({
      engineTenantRef,
      plan: planFor(undefined, { issuerDisplayName: "Contract Test Organisation BV" }),
    });

    const display = (await issuerMetadata()).display as { name?: string }[] | undefined;
    expect(display?.[0]?.name).toBe("Contract Test Organisation BV");
    expect(display?.[0]?.name).not.toBe("Employee badge");
  }, 60_000);

  it("refuses to provision a tenant with no authorization server at all", async () => {
    if (!reachable || !adapter) return;
    // The engine requires a non-empty list and answers a failure a long way from its cause. An
    // empty composition means the provider view was built without the policy being provisioned,
    // which is a platform bug — so it fails here, named.
    await expect(
      adapter.provisionCredentialConfiguration({
        engineTenantRef,
        plan: planFor(undefined, {
          eligibilityPresentations: [],
          requiresBuiltInAuthorizationServer: false,
        }),
      }),
    ).rejects.toMatchObject({ code: "issuer_authorization_servers_empty" });
  }, 60_000);
});
