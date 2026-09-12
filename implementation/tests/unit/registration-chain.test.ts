import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveHashPid,
  checkEntity,
  fingerprint,
  issueAccessCertificate,
  openStore,
  previewStep,
  previousHashPidFingerprint,
  readState,
  runChain,
  STEPS,
  stabilityVerdict,
  stepStatuses,
  storeHashPid,
} from "@edtp/registration-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The registration chain, tested without a network.
 *
 * These are the properties that matter and that a live run cannot safely check, because the service
 * has no idempotency key and no route that amends a half-built registration: getting any of them
 * wrong leaves orphaned entities behind (`docs/interop-findings.md` C9).
 */

const VALID_ENTITY = {
  law: [{ legalBasis: ["consent"], legislativeIdentifier: "GDPR-ART-6" }],
  legalPerson: { legalName: ["Example Test Entity SL"] },
  identifiers: [
    { identifier: "ESB00000000", type: "http://data.europa.eu/eudi/id/VATIN" as const },
  ],
  legalEntity: { country: "ES", email: ["ops@example.org"] },
  policies: {
    wrp: {
      policyURI: "https://example.org/tspa",
      type: "http://data.europa.eu/eudi/policy/trust-service-practice-statement" as const,
    },
    intendedUse: {
      policyURI: "https://example.org/privacy",
      type: "http://data.europa.eu/eudi/policy/privacy-policy" as const,
    },
  },
  provider: { providerType: "WALLET_PROVIDER" },
  credentials: [
    {
      format: "dc+sd-jwt",
      meta: { name: "PID", version: "1.1" },
      claims: [{ path: "$.birthdate" }],
    },
  ],
  intendedUse: {
    intendedUseIdentifier: "age-gate",
    createdAt: "2026-09-12T00:00:00Z",
    revokedAt: "2027-09-12T00:00:00Z",
    purpose: [{ lang: "en", content: "Confirm the customer is an adult" }],
  },
  providedAttestations: [{ format: "dc+sd-jwt", meta: "urn:edtp:employee-badge:1" }],
  supervisoryAuthority: { name: "AEPD", country: "ES" },
  walletRelyingParty: {
    tradeName: "Example Age Gate",
    entitlements: [
      "http://data.europa.eu/eudi/entitlement/Service_Provider",
      "http://data.europa.eu/eudi/entitlement/Non_Q_EAA_Provider",
    ],
    isPSB: false,
    registryURI: "https://example.org/registry",
    supportURI: ["https://example.org/support"],
    srvDescription: [{ lang: "en", content: "Age confirmation" }],
  },
};

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "edtp-reg-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("entity validation", () => {
  it("accepts a complete entity", () => {
    const check = checkEntity(VALID_ENTITY);
    expect(check.problems).toEqual([]);
    expect(check.runnable).toBe(true);
  });

  it("refuses a leftover CHANGE-ME even though it is structurally valid", () => {
    // The point of the rule: a placeholder passes the schema — it is a non-empty string, and a
    // placeholder URL is a well-formed https URL — so only a separate pass catches it. The service
    // would accept it and register a company that does not exist, unamendably.
    const check = checkEntity({
      ...VALID_ENTITY,
      walletRelyingParty: {
        ...VALID_ENTITY.walletRelyingParty,
        tradeName: "CHANGE-ME trade name",
        supportURI: ["https://CHANGE-ME.example.org/support"],
      },
    });
    expect(check.runnable).toBe(false);
    expect(check.problems.map((problem) => problem.path)).toEqual([
      "walletRelyingParty.tradeName",
      "walletRelyingParty.supportURI[0]",
    ]);
    expect(check.problems.every((problem) => problem.kind === "placeholder")).toBe(true);
  });

  it("reports every schema problem at once rather than only the first", () => {
    const check = checkEntity({
      ...VALID_ENTITY,
      identifiers: [{ identifier: "x", type: "http://example.org/not-a-known-scheme" }],
      legalEntity: { country: "ESP", email: ["not-an-email"] },
    });
    expect(check.runnable).toBe(false);
    expect(check.problems.length).toBeGreaterThanOrEqual(3);
  });

  it("warns about an unrecognised entitlement without refusing it", () => {
    // The OpenAPI document does not close the list, so refusing a value the register might accept
    // would be worse than saying so.
    const check = checkEntity({
      ...VALID_ENTITY,
      walletRelyingParty: {
        ...VALID_ENTITY.walletRelyingParty,
        entitlements: ["http://data.europa.eu/eudi/entitlement/Invented_Role"],
      },
    });
    expect(check.runnable).toBe(true);
    expect(check.problems).toHaveLength(1);
    expect(check.problems[0]?.kind).toBe("warning");
  });

  it("rejects a plain-http URL where the service is given a URI we publish", () => {
    const check = checkEntity({
      ...VALID_ENTITY,
      walletRelyingParty: {
        ...VALID_ENTITY.walletRelyingParty,
        supportURI: ["http://example.org/support"],
      },
    });
    expect(check.runnable).toBe(false);
  });
});

describe("the step list", () => {
  it("has fourteen entries counting the two certificates, twelve of which create entities", () => {
    expect(STEPS).toHaveLength(12);
    expect(new Set(STEPS.map((step) => step.key)).size).toBe(12);
  });

  it("puts the Wallet Relying Party last, because it references everything else", () => {
    expect(STEPS.at(-1)?.key).toBe("wallet_rp");
  });

  it("creates the two policies with the intentions their consumers require", () => {
    const entity = checkEntity(VALID_ENTITY).entity;
    if (!entity) throw new Error("fixture is invalid");
    const wrp = STEPS.find((step) => step.key === "policy_wrp");
    const iu = STEPS.find((step) => step.key === "policy_intended_use");
    expect((wrp?.build({ entity, state: {} }) as { intention: string }[])[0]?.intention).toBe(
      "wrp",
    );
    expect((iu?.build({ entity, state: {} }) as { intention: string }[])[0]?.intention).toBe(
      "intended_use",
    );
  });

  it("redacts hash_pid from a previewed body", () => {
    const entity = checkEntity(VALID_ENTITY).entity;
    if (!entity) throw new Error("fixture is invalid");
    const preview = previewStep(STEPS[0] as (typeof STEPS)[number], { entity, state: {} });
    expect(JSON.stringify(preview)).toContain("<redacted>");
  });
});

describe("running the chain", () => {
  /** A service that mints one ascending id per call and records what it was sent. */
  const fakeService = () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    let next = 100;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      next += 1;
      return new Response(JSON.stringify({ data: [next], message: "ok" }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetchImpl };
  };

  it("walks every step in order and records each minted id", async () => {
    const store = openStore(directory);
    storeHashPid(store, "test-credential");
    const { calls, fetchImpl } = fakeService();
    const entity = checkEntity(VALID_ENTITY).entity;
    if (!entity) throw new Error("fixture is invalid");

    const outcomes = await runChain(entity, {
      store,
      fetchImpl,
      baseUrl: "https://registry.test",
    });

    expect(calls.map((call) => call.path)).toEqual(STEPS.map((step) => step.route));
    expect(outcomes.every((outcome) => !outcome.skipped)).toBe(true);
    expect(Object.keys(readState(store))).toHaveLength(12);
  });

  it("passes ids minted by earlier steps into later ones", async () => {
    const store = openStore(directory);
    storeHashPid(store, "test-credential");
    const { calls, fetchImpl } = fakeService();
    const entity = checkEntity(VALID_ENTITY).entity;
    if (!entity) throw new Error("fixture is invalid");

    await runChain(entity, { store, fetchImpl, baseUrl: "https://registry.test" });

    const state = readState(store);
    const walletRp = calls.find((call) => call.path === "/wallet_rp/create");
    const body = (walletRp?.body["WalletRelyingParty"] as Record<string, unknown>[])[0];
    expect(body?.["provider_id"]).toBe(state["provider"]?.[0]);
    expect(body?.["intendedUse_ids"]).toEqual(state["intended_use"]);
    expect(body?.["supervisoryAuthority"]).toBe(state["supervisory_authority"]?.[0]);
  });

  it("resumes rather than recreating: a second run calls nothing", async () => {
    const store = openStore(directory);
    storeHashPid(store, "test-credential");
    const entity = checkEntity(VALID_ENTITY).entity;
    if (!entity) throw new Error("fixture is invalid");

    const first = fakeService();
    await runChain(entity, {
      store,
      fetchImpl: first.fetchImpl,
      baseUrl: "https://registry.test",
    });
    const second = fakeService();
    const outcomes = await runChain(entity, {
      store,
      fetchImpl: second.fetchImpl,
      baseUrl: "https://registry.test",
    });

    // The property that matters most: re-running after a completed chain must not register a
    // second set of entities, because the service offers no way to delete the first.
    expect(second.calls).toHaveLength(0);
    expect(outcomes.every((outcome) => outcome.skipped)).toBe(true);
  });

  it("keeps what succeeded when a later step fails, so the retry resumes", async () => {
    const store = openStore(directory);
    storeHashPid(store, "test-credential");
    const entity = checkEntity(VALID_ENTITY).entity;
    if (!entity) throw new Error("fixture is invalid");

    let seen = 0;
    const failAtFourth = (async () => {
      seen += 1;
      if (seen === 4)
        return new Response(JSON.stringify({ message: "bad country" }), { status: 400 });
      return new Response(JSON.stringify({ data: [seen], message: "ok" }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await expect(
      runChain(entity, { store, fetchImpl: failAtFourth, baseUrl: "https://registry.test" }),
    ).rejects.toThrow();

    const statuses = stepStatuses(readState(store));
    expect(statuses.filter((step) => step.done)).toHaveLength(3);
    expect(statuses[3]?.done).toBe(false);
  });

  it("refuses to continue when a step answers without an id", async () => {
    const store = openStore(directory);
    storeHashPid(store, "test-credential");
    const entity = checkEntity(VALID_ENTITY).entity;
    if (!entity) throw new Error("fixture is invalid");

    // A 200 with no `data` is the accepted-then-wrong shape: continuing would build later bodies
    // around an undefined reference.
    const emptyData = (async () =>
      new Response(JSON.stringify({ message: "ok" }), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(
      runChain(entity, { store, fetchImpl: emptyData, baseUrl: "https://registry.test" }),
    ).rejects.toThrow(/no data array/);
  });

  it("will not run at all without a session credential", async () => {
    const store = openStore(directory);
    const entity = checkEntity(VALID_ENTITY).entity;
    if (!entity) throw new Error("fixture is invalid");
    await expect(runChain(entity, { store })).rejects.toThrow(/log in first/);
  });
});

describe("the certificate", () => {
  it("writes the decoded PKCS#12 mode 600 and never returns its bytes", async () => {
    const store = openStore(directory);
    storeHashPid(store, "test-credential");
    writeFileSync(store.statePath, JSON.stringify({ wallet_rp: [7], intended_use: [9] }));

    const payload = Buffer.from("not-a-real-p12").toString("base64");
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { file_base64: payload } }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await issueAccessCertificate("a-long-enough-passphrase", {
      store,
      fetchImpl,
      baseUrl: "https://registry.test",
    });

    expect(readFileSync(result.path, "utf8")).toBe("not-a-real-p12");
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
  });

  it("refuses a response with no certificate in it rather than writing an empty file", async () => {
    const store = openStore(directory);
    storeHashPid(store, "test-credential");
    writeFileSync(store.statePath, JSON.stringify({ wallet_rp: [7] }));
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: {} }), { status: 200 })) as unknown as typeof fetch;

    // An empty file would only fail later, during the chain check, where it would look like a
    // chain problem rather than a missing response field.
    await expect(
      issueAccessCertificate("a-long-enough-passphrase", {
        store,
        fetchImpl,
        baseUrl: "https://registry.test",
      }),
    ).rejects.toThrow(/file_base64/);
  });

  it("rejects an empty passphrase", async () => {
    const store = openStore(directory);
    storeHashPid(store, "test-credential");
    writeFileSync(store.statePath, JSON.stringify({ wallet_rp: [7] }));
    await expect(issueAccessCertificate("", { store })).rejects.toThrow(/empty passphrase/);
  });
});

describe("the hash_pid stability question", () => {
  it("reports no verdict from a single login", () => {
    const store = openStore(directory);
    storeHashPid(store, "first-credential");
    expect(stabilityVerdict(store)).toBe("unknown");
  });

  it("reports stability when a re-issued PID yields the same credential", () => {
    const store = openStore(directory);
    storeHashPid(store, "same-credential");
    archiveHashPid(store);
    storeHashPid(store, "same-credential");
    expect(stabilityVerdict(store)).toBe("stable");
  });

  it("reports a change when it does not", () => {
    const store = openStore(directory);
    storeHashPid(store, "first-credential");
    archiveHashPid(store);
    storeHashPid(store, "second-credential");
    expect(stabilityVerdict(store)).toBe("changed");
    expect(previousHashPidFingerprint(store)).toBe(fingerprint("first-credential"));
  });

  it("keeps the secret out of the comparison: a digest is not its input", () => {
    expect(fingerprint("a-credential")).not.toContain("a-credential");
    expect(fingerprint("a-credential")).toHaveLength(16);
    expect(fingerprint("a-credential")).toBe(fingerprint("a-credential"));
    expect(fingerprint("a-credential")).not.toBe(fingerprint("b-credential"));
  });
});

describe("the session state file", () => {
  it("holds identifiers only, and no secret", async () => {
    const store = openStore(directory);
    storeHashPid(store, "test-credential");
    const entity = checkEntity(VALID_ENTITY).entity;
    if (!entity) throw new Error("fixture is invalid");
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [1] }), { status: 200 })) as unknown as typeof fetch;

    await runChain(entity, { store, fetchImpl, baseUrl: "https://registry.test" });

    const raw = readFileSync(store.statePath, "utf8");
    expect(raw).not.toContain("test-credential");
    expect(raw).not.toContain("hash_pid");
    expect(statSync(store.statePath).mode & 0o777).toBe(0o600);
  });

  it("refuses a state file that is not an object rather than guessing", () => {
    const store = openStore(directory);
    writeFileSync(store.statePath, JSON.stringify([1, 2, 3]));
    expect(() => readState(store)).toThrow(/not a JSON object/);
  });
});
