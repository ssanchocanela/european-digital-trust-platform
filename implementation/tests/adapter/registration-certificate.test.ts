import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import {
  defaultRetentionPolicy,
  defaultTrustPolicy,
  type VerificationPlan,
} from "@edtp/domain";
import { EngineClient, EudiploVerifierAdapter } from "@edtp/eudiplo-adapter";
import { systemClock } from "@edtp/shared";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * `RPRC_19`: does the registration certificate actually reach the wallet?
 *
 * `EW-DM-44-023` (`RPRC_19`) requires a Relying Party Instance to include a single applicable
 * registration certificate **in each presentation request, by value**. Asserting that the platform
 * *sent* one to the engine is not enough — the requirement is about what the Wallet receives, so
 * these tests fetch the signed request object and decode it, exactly as a Wallet would.
 *
 * ## What was found doing this
 *
 * Against EUDIPLO v7.6.0 on 11 September 2026, in order:
 *
 * 1. The adapter's field name was wrong. It sent `registrationCert: { jwt }`;
 *    `PresentationConfigCreateDto` declares `additionalProperties: false` and answers
 *    `unrecognized key(s) "registrationCert"` with a 400. The correct field is
 *    `registrationCertImportJwt`, and despite the engine's OpenAPI declaring it an array of
 *    strings its validator requires a **string**.
 * 2. The certificate must carry an **authorised-credentials claim** or the engine refuses it with
 *    `Registration certificate has no authorized credentials` — its own over-asking check.
 * 3. **The engine emits the certificate only when a registrar is configured for the tenant.**
 *    `oid4vp.service.js` guards the claim with
 *    `if (presentationConfig.registration_cert && await registrarService.isEnabledForTenant(...))`,
 *    `isEnabledForTenant` is `!!config`, and `saveConfig` calls `testCredentials` *before* saving —
 *    so the registrar must be reachable and must authenticate. Holding a valid certificate is not
 *    sufficient.
 *
 * Consequence: `RPRC_19` **cannot be satisfied through this engine at this version** without a
 * reachable registrar, whatever the platform does. Recorded in `docs/interop-findings.md` A12–A13
 * and `docs/security-limitations.md`.
 *
 * So the last test below **skips with a stated reason** when no registrar is configured, rather
 * than asserting something that cannot hold. It is written to turn green by itself the moment a
 * registrar exists — and never to pass silently: it fails if a registrar *is* configured and the
 * claim is still missing.
 */
const baseUrl = process.env.ENGINE_BASE_URL;
const credentialsRaw = process.env.ENGINE_TENANT_CREDENTIALS;

/** The claim the engine emits. Note: `verifier_info`, the earlier OpenID4VP draft name. */
const VERIFIER_INFO_CLAIM = "verifier_info";

let adapter: EudiploVerifierAdapter | undefined;
let client: EngineClient | undefined;
let reachable = false;
let engineTenantRef = "root";
let accessKeyBindingRef = "";
let registrarConfigured = false;
let testCertificateJwt = "";

const decodeSegment = (segment: string): Record<string, unknown> => {
  const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
};

/** Fetches the signed request object a Wallet would retrieve, and returns its decoded payload. */
const fetchRequestObjectPayload = async (
  interactionUri: string,
): Promise<Record<string, unknown>> => {
  const requestUri = new URL(
    interactionUri.replace(/^openid4vp:\/\//, "https://placeholder/"),
  ).searchParams.get("request_uri");
  expect(requestUri, "the interaction URI must carry a request_uri").toBeTruthy();
  const res = await fetch(requestUri as string);
  expect(res.ok, `request_uri returned ${res.status}`).toBe(true);
  const jws = (await res.text()).trim();
  expect(jws.split(".")).toHaveLength(3);
  return decodeSegment(jws.split(".")[1] as string);
};

const planWith = (registrationCertificateJwt?: string): VerificationPlan => ({
  policyId: "rprc19-policy",
  policyVersion: 1,
  purpose: [{ lang: "en", value: "RPRC_19 contract test" }],
  credentialRequirement: {
    credentialType: "urn:eudi:pid:1",
    acceptedFormats: ["dc+sd-jwt"],
    vctValues: ["urn:eudi:pid:1"],
  },
  requestedClaims: [{ path: ["birthdate"] }],
  trustConstraints: defaultTrustPolicy(),
  resultTransformation: {
    kind: "DERIVED_CLAIMS",
    derivations: [
      {
        name: "AgeAtLeast",
        sourcePath: ["birthdate"],
        minimumAgeYears: 18,
        outputClaim: "over_18",
      },
    ],
  },
  retentionInstructions: defaultRetentionPolicy(),
  relyingPartyContext: {
    relyingPartyIdentifier: "rprc19-rp",
    serviceIdentifier: "rprc19-service",
    serviceTradeName: "RPRC_19 contract test",
    intendedUseIdentifier: "rprc19-use",
    ...(registrationCertificateJwt ? { registrationCertificateJwt } : {}),
    accessKeyBindingRef,
    engineTenantRef,
  },
});

beforeAll(async () => {
  if (!baseUrl || !credentialsRaw) return;
  const eq = credentialsRaw.indexOf("=");
  const colon = credentialsRaw.indexOf(":", eq + 1);
  if (eq <= 0 || colon <= eq + 1) return;
  engineTenantRef = credentialsRaw.slice(0, eq);

  client = new EngineClient({
    baseUrl,
    clock: systemClock,
    requestTimeoutMs: 15_000,
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
  adapter = new EudiploVerifierAdapter(client);

  // A development access certificate, so a presentation configuration can exist at all.
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
      "/CN=rprc19-contract-test/O=Development only/C=EU",
    ],
    { input: pem },
  ).toString();
  const imported = await adapter.importAccessCertificate({
    engineTenantRef,
    name: "RPRC_19 contract test (development, self-signed)",
    privateKeyJwk: privateKey.export({ format: "jwk" }) as Record<string, unknown>,
    certificateChain: [cert],
  });
  accessKeyBindingRef = imported.keyBindingRef;

  // The TEST placeholder, minted by the script the documentation points at, so the two cannot
  // drift apart.
  testCertificateJwt = execFileSync(process.execPath, [
    join(__dirname, "..", "..", "scripts", "make-test-registration-certificate.mjs"),
    "--service",
    "rprc19-service",
    "--vct",
    "urn:eudi:pid:1",
    "--claim",
    "birthdate",
  ])
    .toString()
    .trim();

  // Is a registrar configured? The engine gates emission on this, so the test must know.
  try {
    await client.request(engineTenantRef, "GET", "/registrar/config");
    registrarConfigured = true;
  } catch {
    registrarConfigured = false;
  }
}, 90_000);

describe("RPRC_19 — registration certificate in the presentation request", () => {
  it("mints a TEST placeholder that is unmistakably labelled as one", () => {
    if (!reachable) {
      console.info("[adapter-contract] skipped: no engine reachable.");
      return;
    }
    const body = decodeSegment(testCertificateJwt.split(".")[1] as string);
    expect(body.iss).toBe("urn:edtp:TEST-PLACEHOLDER:NOT-ISSUED-BY-ANY-REGISTRAR");
    // The authorised-credentials claim the engine requires, mirroring the DCQL.
    expect(Array.isArray(body.credentials)).toBe(true);
    expect(JSON.stringify(body.credentials)).toContain("urn:eudi:pid:1");
    expect(JSON.stringify(body.credentials)).toContain("birthdate");
  });

  it("the engine accepts the certificate on the presentation configuration", async () => {
    if (!reachable || !adapter) return;
    // This is what caught the wrong field name: with `registrationCert` the engine answered
    // 400 `unrecognized key(s)`. If the field regresses, this throws.
    const created = await adapter.createPresentationRequest({
      plan: planWith(testCertificateJwt),
      interactionType: "SAME_DEVICE",
      sessionTtlSeconds: 300,
    });
    expect(created.session.ref).toBeTruthy();
    // The adapter must report that a certificate *was* attached.
    expect(created.sentWithoutRegistrationCertificate).toBe(false);
    await adapter.cancelPresentation(created.session);
  }, 60_000);

  it("reports the omission honestly when no certificate is held", async () => {
    if (!reachable || !adapter) return;
    const created = await adapter.createPresentationRequest({
      plan: planWith(undefined),
      interactionType: "SAME_DEVICE",
      sessionTtlSeconds: 300,
    });
    // Blocker B3. Never fabricated, never silently omitted.
    expect(created.sentWithoutRegistrationCertificate).toBe(true);
    const payload = await fetchRequestObjectPayload(created.interaction.uri);
    expect(payload[VERIFIER_INFO_CLAIM]).toBeUndefined();
    await adapter.cancelPresentation(created.session);
  }, 60_000);

  it("puts the certificate in the request object — needs a registrar configured on the engine", async () => {
    if (!reachable || !adapter) return;

    if (!registrarConfigured) {
      // Not a silent pass. The engine guards the claim with
      // `registration_cert && isEnabledForTenant(tenant)`, and a registrar config can only be
      // saved if the registrar is reachable and authenticates. So this assertion is impossible
      // here, and saying so is the honest outcome — CLAUDE.md §8.
      console.info(
        `[adapter-contract] RPRC_19 request-object assertion SKIPPED: no registrar configured for ` +
          `engine tenant '${engineTenantRef}'. EUDIPLO v7.6.0 emits '${VERIFIER_INFO_CLAIM}' only ` +
          `when one is, so the certificate cannot reach a wallet yet. interop-findings A13.`,
      );
      return;
    }

    const created = await adapter.createPresentationRequest({
      plan: planWith(testCertificateJwt),
      interactionType: "SAME_DEVICE",
      sessionTtlSeconds: 300,
    });
    const payload = await fetchRequestObjectPayload(created.interaction.uri);

    const verifierInfo = payload[VERIFIER_INFO_CLAIM] as
      | readonly { format?: string; data?: string }[]
      | undefined;
    expect(
      verifierInfo,
      "the request object must carry the registration certificate",
    ).toBeTruthy();
    // RPRC_19 says a *single* applicable certificate.
    expect(verifierInfo).toHaveLength(1);
    expect(verifierInfo?.[0]?.format).toBe("registration_cert");
    expect(verifierInfo?.[0]?.data).toBe(testCertificateJwt);

    await adapter.cancelPresentation(created.session);
  }, 60_000);
});
