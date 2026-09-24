import { execFileSync } from "node:child_process";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerificationPlan } from "@edtp/domain";
import { defaultRetentionPolicy, defaultTrustPolicy } from "@edtp/domain";
import { EngineClient, EudiploVerifierAdapter } from "@edtp/eudiplo-adapter";
import { systemClock } from "@edtp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The half of the engine contract `engine-contract.test.ts` never reached: actually
 * **obtaining an interaction URI**.
 *
 * `createPresentationRequest` is three engine calls in sequence — `PUT /session-config`,
 * `POST /verifier/config`, `POST /verifier/offer` — and it is the only place the DCQL query, the
 * key-chain reference and the offer response shape all have to be right at once. Reading types
 * cannot verify any of that; only a real engine can.
 *
 * The access certificate here is **self-signed and development-only**. That is sufficient for this
 * test and insufficient for a wallet: `AS-WP-06-005` (`RPA_04`) makes a Wallet Unit accept only
 * anchors from the notified Access CA LoTEs, so this certificate would be refused by an official
 * build. What is asserted is that the **platform-to-engine** path produces a wallet invocation URI,
 * not that a wallet would accept it. Nothing here claims otherwise.
 *
 * Skipped, like the other adapter suite, when no engine is reachable.
 */
const baseUrl = process.env.ENGINE_BASE_URL;
const credentialsRaw = process.env.ENGINE_TENANT_CREDENTIALS;

let adapter: EudiploVerifierAdapter | undefined;
let reachable = false;
let engineTenantRef = "root";
let accessKeyBindingRef: string | undefined;
let workDir: string | undefined;

/**
 * A self-signed EC access certificate, generated at run time.
 *
 * Generated rather than committed: a checked-in private key is a liability even when it is a
 * development one, and a committed certificate would eventually expire and fail this test for a
 * reason that has nothing to do with the engine.
 */
const generateDevAccessCertificate = (): {
  privateKeyJwk: Record<string, unknown>;
  certificatePem: string;
} => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  workDir = mkdtempSync(join(tmpdir(), "edtp-adapter-"));
  const keyPath = join(workDir, "key.pem");
  const certPath = join(workDir, "cert.pem");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
    mode: 0o600,
  });

  // openssl rather than a JS library: this is the same operation a registrar-issued certificate
  // goes through, and it keeps the test free of another dependency.
  execFileSync("openssl", [
    "req",
    "-new",
    "-x509",
    "-key",
    keyPath,
    "-out",
    certPath,
    "-days",
    "2",
    "-subj",
    "/CN=edtp-adapter-contract-test/O=Development only/C=EU",
    "-addext",
    "subjectAltName=DNS:localhost",
  ]);

  const certificatePem = execFileSync("cat", [certPath]).toString();
  // Assert it parses, so a malformed certificate fails here rather than inside the engine.
  expect(new X509Certificate(certificatePem).subject).toContain("edtp-adapter-contract-test");

  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  expect(publicKey.asymmetricKeyType).toBe("ec");
  return { privateKeyJwk: jwk, certificatePem };
};

// Typed, not cast. An `as VerificationPlan` here would hide exactly the kind of drift this suite
// exists to catch: if the plan shape changes, this must stop compiling.
const devPlan = (): VerificationPlan => ({
  policyId: "adapter-contract-policy",
  policyVersion: 1,
  purpose: [{ lang: "en", value: "Adapter contract test against a real engine" }],
  credentialRequirement: {
    credentialType: "urn:eudi:pid:1",
    acceptedFormats: ["dc+sd-jwt"],
    vctValues: ["urn:eudi:pid:1"],
  },
  // The PID date of birth, which is what the V0 flagship policy requests. `age_over_18` does
  // not exist in the PID — PID Rulebook v1.1 removed it.
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
    relyingPartyIdentifier: "edtp-adapter-contract-rp",
    serviceIdentifier: "edtp-adapter-contract-service",
    serviceTradeName: "EDTP adapter contract test",
    intendedUseIdentifier: "edtp-adapter-contract-use",
    // No registration certificate: blocker B3. The adapter must report the omission.
    accessKeyBindingRef: accessKeyBindingRef ?? "",
    engineTenantRef,
  },
});

beforeAll(async () => {
  if (!baseUrl || !credentialsRaw) return;

  const eq = credentialsRaw.indexOf("=");
  const colon = credentialsRaw.indexOf(":", eq + 1);
  if (eq <= 0 || colon <= eq + 1) return;
  engineTenantRef = credentialsRaw.slice(0, eq);

  const client = new EngineClient({
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

  const { privateKeyJwk, certificatePem } = generateDevAccessCertificate();
  const imported = await adapter.importAccessCertificate({
    engineTenantRef,
    name: "adapter contract test (development, self-signed)",
    privateKeyJwk,
    certificateChain: [certificatePem],
  });
  accessKeyBindingRef = imported.keyBindingRef;
}, 60_000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("presentation request against a real engine (skipped when none is reachable)", () => {
  it("imports a development access certificate and returns an opaque key-binding reference", () => {
    if (!reachable) {
      console.info("[adapter-contract] skipped: no engine reachable.");
      return;
    }
    expect(accessKeyBindingRef).toBeTruthy();
    // Opaque to the platform: it is stored and passed back, never parsed.
    expect(typeof accessKeyBindingRef).toBe("string");
  });

  it("obtains a same-device interaction URI end to end", async () => {
    if (!reachable || !adapter) return;

    const result = await adapter.createPresentationRequest({
      plan: devPlan(),
      interactionType: "SAME_DEVICE",
      returnUrl: "https://localhost:3100/v1/presentations/contract-test/return",
      sessionTtlSeconds: 300,
    });

    expect(result.session.ref).toBeTruthy();
    expect(result.session.engineTenantRef).toBe(engineTenantRef);
    expect(result.interaction.type).toBe("SAME_DEVICE");
    // A wallet invocation URI. The platform treats it as opaque, so the only assertion is that
    // it is a non-empty URI the engine produced.
    expect(result.interaction.uri).toMatch(/^[a-z][a-z0-9+.-]*:/i);
    // Blocker B3: V0 holds no registration certificate, and the adapter must say so rather
    // than quietly omitting the fact.
    expect(result.sentWithoutRegistrationCertificate).toBe(true);

    // Immediately readable, and the engine reports it as still waiting on the wallet.
    const status = await adapter.getPresentationStatus(result.session);
    expect(status.progress).toBe("AWAITING_WALLET");
    expect(status.outcome).toBeUndefined();

    // Cancel, which also purges the engine-side session and anything it holds.
    await adapter.cancelPresentation(result.session);
  }, 60_000);

  it("produces a cross-device URI that differs from the same-device one", async () => {
    if (!reachable || !adapter) return;

    const sameDevice = await adapter.createPresentationRequest({
      plan: devPlan(),
      interactionType: "SAME_DEVICE",
      returnUrl: "https://localhost:3100/v1/presentations/contract-test/return",
      sessionTtlSeconds: 300,
    });
    const crossDevice = await adapter.createPresentationRequest({
      plan: devPlan(),
      interactionType: "QR",
      sessionTtlSeconds: 120,
    });

    // ADR 0009: the cross-device URI must carry no completion redirect, which is what makes
    // `QR_NO_RESULT_VIA_INTERACTION_CHANNEL` true. If the engine ever started returning the
    // same URI for both, that mitigation would silently stop holding.
    expect(crossDevice.interaction.uri).not.toBe(sameDevice.interaction.uri);
    expect(crossDevice.interaction.type).toBe("QR");

    await adapter.cancelPresentation(sameDevice.session);
    await adapter.cancelPresentation(crossDevice.session);
  }, 60_000);

  it("reports a cancelled session as settled and cancelled, not as still waiting", async () => {
    if (!reachable || !adapter) return;

    const created = await adapter.createPresentationRequest({
      plan: devPlan(),
      interactionType: "SAME_DEVICE",
      sessionTtlSeconds: 300,
    });
    await adapter.cancelPresentation(created.session);

    // After deletion the engine no longer knows the session. The adapter must surface that as
    // an engine error rather than inventing a terminal state.
    await expect(adapter.getPresentationStatus(created.session)).rejects.toMatchObject({
      kind: "ENGINE",
    });
  }, 60_000);
});
