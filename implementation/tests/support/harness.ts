import { generateKeyPairSync, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DisclosedClaims, TerminalState, VerificationPlan } from "@edtp/domain";
import type {
  CreatePresentationRequestInput,
  CreatePresentationRequestOutput,
  EngineRetentionSettings,
  EngineSessionHandle,
  EudiVerifierPort,
  EudiVerifierProvisioningPort,
  ImportAccessCertificateInput,
  PresentationResultPayload,
  PresentationStatus,
} from "@edtp/eudi-verifier-port";
import { createDatabase, type DatabaseHandle, runMigrations } from "@edtp/persistence";
import { asId, FixedClock, newOpaqueToken } from "@edtp/shared";
import { Pool } from "pg";
import {
  buildDependencies,
  type Dependencies,
} from "../../apps/platform-api/src/composition.js";
import { loadConfig, type PlatformConfig } from "../../apps/platform-api/src/config.js";
import { Logger, type LogSink } from "../../apps/platform-api/src/logging/logger.js";

/**
 * Integration harness.
 *
 * Builds the real dependency graph — real repositories, real services, real PostgreSQL,
 * the checked-in migrations — against a **fake verifier port**. That is precisely the
 * "business layer with mocked ports, without EUDIPLO" suite the V0 plan asks for: every
 * layer the platform owns is exercised, and only the wrapped engine is substituted.
 */

export interface CapturedLog {
  readonly lines: string[];
  readonly sink: LogSink;
}

export const capturingSink = (): CapturedLog => {
  const lines: string[] = [];
  return { lines, sink: { write: (line) => lines.push(line) } };
};

/**
 * Fake verifier port.
 *
 * Records what the adapter would have been asked to do, and lets a test script the
 * engine's answers. It deliberately implements the same stateless handle-based contract as
 * the real adapter, so a test cannot accidentally depend on per-process session state the
 * real adapter does not keep.
 */
export class FakeVerifier implements EudiVerifierPort, EudiVerifierProvisioningPort {
  readonly createdPlans: VerificationPlan[] = [];
  /** Full inputs, so a test can assert what the adapter was actually asked for. */
  readonly createdRequests: CreatePresentationRequestInput[] = [];
  readonly retentionCalls: { engineTenantRef: string; settings: EngineRetentionSettings }[] =
    [];
  readonly cancelled: string[] = [];
  readonly imports: ImportAccessCertificateInput[] = [];

  /** Scripted per-session responses. */
  private statuses = new Map<string, PresentationStatus>();
  private claims = new Map<string, DisclosedClaims>();
  private failCreate: Error | undefined;
  private counter = 0;

  /** The most recently created session reference. */
  lastSessionRef(): string {
    if (this.counter === 0) {
      throw new Error("No engine session has been created yet.");
    }
    return `engine-session-${this.counter}`;
  }

  failNextCreate(error: Error): void {
    this.failCreate = error;
  }

  /** Scripts the most recent session, so a test never names a reference by hand. */
  settleLastVerified(disclosed: DisclosedClaims): void {
    this.settleVerified(this.lastSessionRef(), disclosed);
  }

  settleLastAs(outcome: TerminalState, failureCode?: string): void {
    this.settleAs(this.lastSessionRef(), outcome, failureCode);
  }

  settleAs(ref: string, outcome: TerminalState, failureCode?: string): void {
    this.statuses.set(ref, {
      progress: "SETTLED",
      outcome,
      ...(failureCode ? { failureCode } : {}),
    });
  }

  settleVerified(ref: string, disclosed: DisclosedClaims): void {
    this.statuses.set(ref, { progress: "SETTLED", outcome: "VERIFIED" });
    this.claims.set(ref, disclosed);
  }

  settleVerifierSideFailure(ref: string): void {
    this.statuses.set(ref, {
      progress: "SETTLED",
      outcome: "TRUST_ERROR",
      failureCode: "trust_list_unavailable",
      verifierSideFailure: true,
    });
  }

  async createPresentationRequest(
    input: CreatePresentationRequestInput,
  ): Promise<CreatePresentationRequestOutput> {
    if (this.failCreate) {
      const error = this.failCreate;
      this.failCreate = undefined;
      throw error;
    }
    this.createdPlans.push(input.plan);
    this.createdRequests.push(input);
    this.counter += 1;
    const ref = `engine-session-${this.counter}`;
    this.statuses.set(ref, { progress: "AWAITING_WALLET" });
    return {
      session: {
        ref: asId<"EngineSessionRef">(ref),
        engineTenantRef: input.plan.relyingPartyContext.engineTenantRef,
      },
      interaction: {
        type: input.interactionType,
        uri:
          input.interactionType === "QR"
            ? `openid4vp://?cross-device=${ref}`
            : `openid4vp://?same-device=${ref}`,
      },
      sentWithoutRegistrationCertificate:
        input.plan.relyingPartyContext.registrationCertificateJwt === undefined,
    };
  }

  async getPresentationStatus(session: EngineSessionHandle): Promise<PresentationStatus> {
    return this.statuses.get(session.ref) ?? { progress: "AWAITING_WALLET" };
  }

  async processPresentationResult(
    session: EngineSessionHandle,
  ): Promise<PresentationResultPayload> {
    const status = this.statuses.get(session.ref) ?? { progress: "AWAITING_WALLET" };
    const disclosed = this.claims.get(session.ref);
    return { ...status, ...(disclosed ? { disclosedClaims: disclosed } : {}) };
  }

  async cancelPresentation(session: EngineSessionHandle): Promise<void> {
    this.cancelled.push(session.ref);
  }

  async applyRetentionSettings(
    engineTenantRef: string,
    settings: EngineRetentionSettings,
  ): Promise<void> {
    this.retentionCalls.push({ engineTenantRef, settings });
  }

  async importAccessCertificate(
    input: ImportAccessCertificateInput,
  ): Promise<{ readonly keyBindingRef: string }> {
    this.imports.push(input);
    return { keyBindingRef: `key-chain-${this.imports.length}` };
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  /**
   * Clears recorded calls, scripted responses **and the session counter**.
   *
   * Resetting the counter matters: without it, session references keep incrementing across
   * tests in a file, so a test that scripts `engine-session-1` would be scripting a session
   * no longer in play — and would fail for a reason that has nothing to do with the code
   * under test.
   */
  reset(): void {
    this.createdPlans.length = 0;
    this.createdRequests.length = 0;
    this.retentionCalls.length = 0;
    this.cancelled.length = 0;
    this.imports.length = 0;
    this.statuses.clear();
    this.claims.clear();
    this.failCreate = undefined;
    this.counter = 0;
  }
}

export interface Harness {
  readonly deps: Dependencies;
  readonly verifier: FakeVerifier;
  readonly clock: FixedClock;
  readonly logs: CapturedLog;
  readonly config: PlatformConfig;
  readonly handle: DatabaseHandle;
  /** Truncates every table so each test starts from a known state. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = join(__dirname, "..", "..", "packages", "persistence", "migrations");

export const ADMIN_KEY = `admin_${"a".repeat(40)}`;

export const createHarness = async (options?: {
  readonly fetchImpl?: typeof fetch;
  readonly now?: Date;
}): Promise<Harness> => {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. The integration suite boots PostgreSQL in its global " +
        "setup; run it through `pnpm test:integration`.",
    );
  }

  // One database per harness, so each test file is fully isolated. Sharing one database and
  // truncating between tests would let concurrent files wipe each other's data — a failure
  // that looks like a bug in the code under test but is not.
  const databaseName = `edtp_t_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const adminPool = new Pool({ connectionString: baseUrl });
  await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  const target = new URL(baseUrl);
  target.pathname = `/${databaseName}`;
  const connectionString = target.toString();

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: connectionString,
    PLATFORM_ADMIN_API_KEY: ADMIN_KEY,
    ENGINE_BASE_URL: "http://engine.invalid",
    ENGINE_TENANT_CREDENTIALS: "engine-tenant-a=client-a:secret-a",
    PLATFORM_PUBLIC_URL: "https://platform.test",
    LOG_LEVEL: "debug",
  });

  const handle = createDatabase({ connectionString });
  await runMigrations(handle.pool, MIGRATIONS_DIR);

  const clock = new FixedClock(options?.now ?? new Date("2026-09-11T08:00:00.000Z"));
  const logs = capturingSink();
  const logger = new Logger("debug", logs.sink);
  const verifier = new FakeVerifier();

  const deps = buildDependencies({
    config,
    db: handle.db,
    clock,
    logger,
    verifier,
    provisioning: verifier,
    ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const reset = async (): Promise<void> => {
    // Truncate rather than drop: the schema under test is the migrated one, and recreating
    // it per test would make the migration the thing being exercised rather than the code.
    await handle.pool.query(
      `TRUNCATE TABLE
         webhook_deliveries, audit_events, presentation_results,
         presentation_transaction_transitions, presentation_transactions,
         presentation_policy_versions, presentation_policies,
         access_certificates, registration_certificates, relying_party_instances,
         intended_uses, relying_party_services, relying_parties, organisations,
         api_keys, tenants
       RESTART IDENTITY CASCADE`,
    );
    logs.lines.length = 0;
    verifier.reset();
  };

  return {
    deps,
    verifier,
    clock,
    logs,
    config,
    handle,
    reset,
    close: async () => {
      await handle.close();
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    },
  };
};

/**
 * A throwaway EC private JWK, generated freshly for each test run.
 *
 * Generated rather than checked in, so the repository contains **no** static private key
 * material at all — not even a fixture that a reader might mistake for something usable, or
 * that a scanner might flag. The fake verifier never uses it cryptographically; it only has to
 * be a well-formed JWK.
 */
export const TEST_PRIVATE_JWK: Readonly<Record<string, unknown>> = (() => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ format: "jwk" }) as Readonly<Record<string, unknown>>;
})();

export const TEST_CERTIFICATE_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIBfakeTestCertificateOnly\n-----END CERTIFICATE-----";

export const randomSecret = (): string => newOpaqueToken(16);
