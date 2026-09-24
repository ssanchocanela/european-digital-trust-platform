import { newCorrelationId } from "@edtp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyWebhookSignature,
} from "../../apps/platform-api/src/webhook/signing.js";
import { createHarness, type Harness } from "../support/harness.js";
import { type SeededTenant, seedTenant } from "../support/seed.js";

/**
 * Result delivery and retention.
 *
 * Three things are asserted: the callback is signed the way integrators are told to verify
 * it, the payload contains **no** presentation content, and the retention job deletes
 * normalised results while leaving transaction metadata and the audit trail — which is the
 * point of keeping the data classes in separate tables (ADR 0004).
 */
const CALLBACK_URL = "https://verifier.example/hooks/presentations";

interface CapturedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

let harness: Harness;
let seeded: SeededTenant;
let captured: CapturedRequest[];
let nextStatus: number;

const recordingFetch: typeof fetch = async (input, init) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
    headers[k.toLowerCase()] = v;
  }
  captured.push({
    url: typeof input === "string" ? input : String(input),
    headers,
    body: typeof init?.body === "string" ? init.body : "",
  });
  return new Response(null, { status: nextStatus });
};

beforeAll(async () => {
  captured = [];
  nextStatus = 204;
  harness = await createHarness({ fetchImpl: recordingFetch });
});

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.reset();
  captured = [];
  nextStatus = 204;
  seeded = await seedTenant(harness, { callbackUrlAllowList: [CALLBACK_URL] });
});

const settleVerified = async (businessReference: string) => {
  const created = await harness.deps.services.presentations.create({
    tenantId: seeded.tenantId,
    policyId: seeded.policyId,
    businessReference,
    callbackUrl: CALLBACK_URL,
    correlationId: newCorrelationId(),
  });
  // Script the session this call actually created. Naming `engine-session-1` by hand breaks
  // as soon as a test creates more than one transaction.
  harness.verifier.settleLastVerified({ birthdate: "1990-05-17" });
  await harness.deps.services.presentations.get(
    seeded.tenantId,
    created.presentationId,
    newCorrelationId(),
  );
  return created;
};

describe("callback allow-list", () => {
  it("accepts a registered callback URL", async () => {
    const created = await harness.deps.services.presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-allowed",
      callbackUrl: CALLBACK_URL,
      correlationId: newCorrelationId(),
    });
    expect(created.presentationId).toBeTruthy();
  });

  it("refuses an unregistered callback URL (SSRF protection)", async () => {
    // Without the allow-list a caller could point the platform's outbound request at an
    // internal address and use the platform as an SSRF proxy.
    await expect(
      harness.deps.services.presentations.create({
        tenantId: seeded.tenantId,
        policyId: seeded.policyId,
        businessReference: "order-ssrf",
        callbackUrl: "https://attacker.example/collect",
        correlationId: newCorrelationId(),
      }),
    ).rejects.toMatchObject({ code: "callback_url_not_allowed", kind: "FORBIDDEN" });
  });

  it("refuses a non-HTTPS callback URL", async () => {
    await expect(
      harness.deps.services.presentations.create({
        tenantId: seeded.tenantId,
        policyId: seeded.policyId,
        businessReference: "order-http",
        callbackUrl: "http://verifier.example/hooks/presentations",
        correlationId: newCorrelationId(),
      }),
    ).rejects.toMatchObject({ code: "callback_url_not_https" });
  });

  it("refuses a URL that only shares a prefix with a registered one", async () => {
    // Exact match, not prefix match: a registered `/hooks/presentations` must not authorise
    // `/hooks/presentations/../../internal`.
    await expect(
      harness.deps.services.presentations.create({
        tenantId: seeded.tenantId,
        policyId: seeded.policyId,
        businessReference: "order-prefix",
        callbackUrl: `${CALLBACK_URL}/../../internal`,
        correlationId: newCorrelationId(),
      }),
    ).rejects.toMatchObject({ code: "callback_url_not_allowed" });
  });
});

describe("webhook delivery", () => {
  it("delivers a signed payload that verifies with the documented recipe", async () => {
    await settleVerified("order-deliver");

    const outcome = await harness.deps.services.webhooks.deliverDue(newCorrelationId());
    expect(outcome.delivered).toBe(1);
    expect(captured).toHaveLength(1);

    const request = captured[0] as CapturedRequest;
    expect(request.url).toBe(CALLBACK_URL);

    // Exactly the verification an integrator is told to perform.
    const verified = verifyWebhookSignature({
      secret: seeded.webhookSecret,
      body: request.body,
      signature: request.headers[SIGNATURE_HEADER] as string,
      timestamp: request.headers[TIMESTAMP_HEADER] as string,
      now: harness.clock.now(),
    });
    expect(verified).toBe(true);
    expect(request.headers[EVENT_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sends the normalised result and no presentation content", async () => {
    await settleVerified("order-payload");
    await harness.deps.services.webhooks.deliverDue(newCorrelationId());

    const body = JSON.parse((captured[0] as CapturedRequest).body);
    expect(body.event).toBe("presentation.settled");
    expect(body.status).toBe("VERIFIED");
    expect(body.result).toEqual({ claims: { over_18: true } });
    // The source value never leaves the call stack that derived from it.
    expect((captured[0] as CapturedRequest).body).not.toContain("1990-05-17");
  });

  it("marks delivery DELIVERED on the transaction", async () => {
    await settleVerified("order-delivered-status");
    await harness.deps.services.webhooks.deliverDue(newCorrelationId());

    const { rows } = await harness.handle.pool.query<{ delivery_status: string }>(
      'SELECT "delivery_status" FROM "presentation_transactions" WHERE "business_reference" = $1',
      ["order-delivered-status"],
    );
    expect(rows[0]?.delivery_status).toBe("DELIVERED");
  });

  it("retries with backoff and gives up at the attempt cap", async () => {
    nextStatus = 500;
    await settleVerified("order-retry");

    let attempts = 0;
    for (let i = 0; i < harness.config.WEBHOOK_MAX_ATTEMPTS + 2; i += 1) {
      const outcome = await harness.deps.services.webhooks.deliverDue(newCorrelationId());
      attempts += outcome.failed;
      // Advance past the backoff so the next pass finds it due.
      harness.clock.advance(120_000);
    }

    expect(attempts).toBe(harness.config.WEBHOOK_MAX_ATTEMPTS);

    const { rows } = await harness.handle.pool.query<{ status: string; attempt: number }>(
      'SELECT "status", "attempt" FROM "webhook_deliveries"',
    );
    expect(rows[0]?.status).toBe("FAILED");
    expect(rows[0]?.attempt).toBe(harness.config.WEBHOOK_MAX_ATTEMPTS);
  });

  it("keeps the verification outcome and the result readable after delivery fails", async () => {
    nextStatus = 500;
    const created = await settleVerified("order-delivery-failed");
    for (let i = 0; i < harness.config.WEBHOOK_MAX_ATTEMPTS; i += 1) {
      await harness.deps.services.webhooks.deliverDue(newCorrelationId());
      harness.clock.advance(120_000);
    }

    // A delivery failure must never change what was verified.
    const view = await harness.deps.services.presentations.get(
      seeded.tenantId,
      created.presentationId,
      newCorrelationId(),
    );
    expect(view.status).toBe("VERIFIED");
    expect(view.result?.claims).toEqual({ over_18: true });

    const { rows } = await harness.handle.pool.query<{ delivery_status: string }>(
      'SELECT "delivery_status" FROM "presentation_transactions" WHERE id = $1',
      [created.presentationId],
    );
    expect(rows[0]?.delivery_status).toBe("FAILED");
  });

  it("enqueues one delivery per settlement, keyed by a unique event id", async () => {
    await settleVerified("order-once");
    // Reading the transaction again must not enqueue a second delivery.
    await harness.deps.services.presentations.get(
      seeded.tenantId,
      (
        await harness.deps.repositories.transactions.find(
          seeded.tenantId,
          (
            await harness.handle.pool.query<{ id: string }>(
              'SELECT id FROM "presentation_transactions" WHERE "business_reference" = $1',
              ["order-once"],
            )
          ).rows[0]?.id as never,
        )
      )?.id as never,
      newCorrelationId(),
    );

    const { rows } = await harness.handle.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "webhook_deliveries"',
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("does not enqueue a delivery when no callback is registered on the request", async () => {
    const created = await harness.deps.services.presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-no-callback",
      correlationId: newCorrelationId(),
    });
    harness.verifier.settleLastVerified({ birthdate: "1990-05-17" });
    await harness.deps.services.presentations.get(
      seeded.tenantId,
      created.presentationId,
      newCorrelationId(),
    );

    const { rows } = await harness.handle.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "webhook_deliveries"',
    );
    expect(rows[0]?.count).toBe("0");

    const { rows: tx } = await harness.handle.pool.query<{ delivery_status: string }>(
      'SELECT "delivery_status" FROM "presentation_transactions" WHERE id = $1',
      [created.presentationId],
    );
    expect(tx[0]?.delivery_status).toBe("NOT_REQUIRED");
  });
});

describe("retention", () => {
  it("purges the normalised result but keeps metadata and audit evidence", async () => {
    const created = await settleVerified("order-retention");

    // Evidence that a verification happened must outlive the values it produced.
    harness.clock.advance(86_401_000);
    const purged = await harness.deps.repositories.transactions.purgeExpiredResults(
      harness.clock.now(),
    );
    expect(purged).toBe(1);

    expect(
      await harness.deps.repositories.transactions.findResult(
        seeded.tenantId,
        created.presentationId,
      ),
    ).toBeUndefined();

    const tx = await harness.deps.repositories.transactions.find(
      seeded.tenantId,
      created.presentationId,
    );
    expect(tx?.state).toBe("VERIFIED");

    const transitions = await harness.deps.repositories.transactions.listTransitions(
      created.presentationId,
    );
    expect(transitions.length).toBeGreaterThan(0);

    const audit = await harness.deps.services.audit.listForPresentation(
      seeded.tenantId,
      created.presentationId,
    );
    expect(audit.length).toBeGreaterThan(0);
  });

  it("does not purge a result whose retention window is still open", async () => {
    const created = await settleVerified("order-retention-open");
    harness.clock.advance(3_600_000);
    expect(
      await harness.deps.repositories.transactions.purgeExpiredResults(harness.clock.now()),
    ).toBe(0);
    expect(
      await harness.deps.repositories.transactions.findResult(
        seeded.tenantId,
        created.presentationId,
      ),
    ).toBeDefined();
  });
});

describe("background jobs", () => {
  it("expires, purges and delivers in one pass", async () => {
    // An abandoned transaction, which only the job can close.
    await harness.deps.services.presentations.create({
      tenantId: seeded.tenantId,
      policyId: seeded.policyId,
      businessReference: "order-abandoned",
      correlationId: newCorrelationId(),
    });
    // A settled one with a pending delivery.
    await settleVerified("order-job-delivery");

    harness.clock.advance(301_000);
    const outcome = await harness.deps.jobs.runOnce();

    expect(outcome.expired).toBe(1);
    expect(outcome.delivered).toBe(1);

    const { rows } = await harness.handle.pool.query<{ state: string }>(
      'SELECT state FROM "presentation_transactions" WHERE "business_reference" = $1',
      ["order-abandoned"],
    );
    expect(rows[0]?.state).toBe("EXPIRED");
  });

  it("reports nothing to do on an idle pass", async () => {
    const outcome = await harness.deps.jobs.runOnce();
    expect(outcome).toEqual({
      expired: 0,
      purgedResults: 0,
      delivered: 0,
      failedDeliveries: 0,
    });
  });
});
