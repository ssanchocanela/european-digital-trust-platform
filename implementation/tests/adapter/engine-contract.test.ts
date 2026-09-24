import { EngineClient, EudiploVerifierAdapter } from "@edtp/eudiplo-adapter";
import { systemClock } from "@edtp/shared";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Adapter contract tests against a **real engine container**.
 *
 * Kept in a separate project and **skipped when the container is unavailable**, as the V0
 * plan requires: a missing engine must never fail the build. The rest of the suite covers
 * the platform without it.
 *
 * These tests exist because the engine is the one dependency whose contract the platform
 * cannot verify by reading types: its documentation diverges from its code in at least seven
 * places (`docs/interop-findings.md` section A), and it ships releases roughly weekly. What
 * is asserted here is the contract the adapter depends on, so an engine upgrade that breaks
 * it fails loudly in CI rather than silently in production.
 *
 * To run:
 *
 * ```
 * docker compose up -d eudiplo
 * ENGINE_BASE_URL=http://localhost:3000 \
 *   ENGINE_TENANT_CREDENTIALS='root=root:root' \
 *   pnpm test:adapter
 * ```
 */
const baseUrl = process.env.ENGINE_BASE_URL;
const credentialsRaw = process.env.ENGINE_TENANT_CREDENTIALS;

let reachable = false;
let client: EngineClient | undefined;
let adapter: EudiploVerifierAdapter | undefined;
let engineTenantRef = "root";

beforeAll(async () => {
  if (!baseUrl || !credentialsRaw) return;

  const eq = credentialsRaw.indexOf("=");
  const colon = credentialsRaw.indexOf(":", eq + 1);
  if (eq <= 0 || colon <= eq + 1) return;
  engineTenantRef = credentialsRaw.slice(0, eq);
  const clientId = credentialsRaw.slice(eq + 1, colon);
  const clientSecret = credentialsRaw.slice(colon + 1);

  client = new EngineClient({
    baseUrl,
    clock: systemClock,
    requestTimeoutMs: 10_000,
    credentials: {
      resolve: async (ref: string) => ({ engineTenantRef: ref, clientId, clientSecret }),
    },
  });
  adapter = new EudiploVerifierAdapter(client);
  reachable = await client.health();
});

/**
 * Skips rather than fails when the engine is absent.
 *
 * `describe.skipIf` is evaluated at collection time, before `beforeAll` has run, so the
 * guard is inside each test instead.
 */
const requireEngine = ():
  | { client: EngineClient; adapter: EudiploVerifierAdapter }
  | undefined => {
  if (!reachable || !client || !adapter) return undefined;
  return { client, adapter };
};

describe("engine contract (skipped when no engine container is reachable)", () => {
  it("reports whether the engine was reachable, so a skip is never silent", () => {
    if (!baseUrl || !credentialsRaw) {
      console.info(
        "[adapter-contract] skipped: set ENGINE_BASE_URL and ENGINE_TENANT_CREDENTIALS to run.",
      );
    } else if (!reachable) {
      console.info(`[adapter-contract] skipped: no engine reachable at ${baseUrl}.`);
    }
    expect(true).toBe(true);
  });

  it("authenticates with client credentials and answers the health check", async () => {
    const ctx = requireEngine();
    if (!ctx) return;
    expect(await ctx.client.health()).toBe(true);
  });

  it("applies the mandatory retention settings and they are accepted", async () => {
    const ctx = requireEngine();
    if (!ctx) return;
    // ADR 0004: the engine's default session TTL retains disclosed claims for 24 hours, so
    // the platform must be able to bring it down to the transaction lifetime.
    await expect(
      ctx.adapter.applyRetentionSettings(engineTenantRef, {
        sessionTtlSeconds: 300,
        cleanupMode: "ANONYMIZE",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a session TTL below the engine minimum, and the adapter clamps it", async () => {
    const ctx = requireEngine();
    if (!ctx) return;
    // The engine enforces a 60-second floor. The adapter clamps rather than letting the
    // engine reject the call, so this must succeed.
    await expect(
      ctx.adapter.applyRetentionSettings(engineTenantRef, {
        sessionTtlSeconds: 1,
        cleanupMode: "ANONYMIZE",
      }),
    ).resolves.toBeUndefined();
  });

  it("returns a structured error for an unknown session rather than a success", async () => {
    const ctx = requireEngine();
    if (!ctx) return;
    await expect(
      ctx.adapter.getPresentationStatus({
        ref: "00000000-0000-0000-0000-000000000000" as never,
        engineTenantRef,
      }),
    ).rejects.toMatchObject({ kind: "ENGINE" });
  });

  it("surfaces an authentication failure as an engine error, not as a success", async () => {
    if (!baseUrl) return;
    const badClient = new EngineClient({
      baseUrl,
      clock: systemClock,
      credentials: {
        resolve: async (ref: string) => ({
          engineTenantRef: ref,
          clientId: "not-a-client",
          clientSecret: "not-a-secret",
        }),
      },
    });
    if (!(await badClient.health())) return;

    await expect(
      new EudiploVerifierAdapter(badClient).applyRetentionSettings(engineTenantRef, {
        sessionTtlSeconds: 300,
        cleanupMode: "ANONYMIZE",
      }),
    ).rejects.toMatchObject({ kind: "ENGINE" });
  });
});
