import { randomUUID } from "node:crypto";
import { tables } from "@edtp/persistence";
import {
  asId,
  newOpaqueToken,
  newWebhookDeliveryId,
  newWebhookEndpointId,
  newWebhookEventId,
} from "@edtp/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyWebhookSignature,
} from "../../apps/platform-api/src/webhook/signing.js";
import { createHarness, type Harness } from "../support/harness.js";

/**
 * Issuance callbacks go through the **same** queue, signing, retry schedule and idempotency as
 * verification — which is the whole point of moving the webhook endpoint into the shared kernel.
 *
 * Milestone 1 put the signing secret on `RelyingPartyService`, so the delivery path resolved it by
 * walking presentation → Service. An issuance has neither, and the two available bad answers were to
 * sign with a Relying Party's secret — misattributing the callback — or not to deliver. Neither was
 * acceptable, so the endpoint became a tenant-scoped kernel object that both sides reference.
 *
 * These tests assert the reuse is real rather than parallel: a second implementation that happened to
 * behave similarly today would drift, and the one that drifts is the one nobody is looking at.
 */
let harness: Harness;
const captured: {
  url: string;
  body: string;
  headers: Record<string, string>;
}[] = [];
let respondWith: () => Response = () => new Response("", { status: 200 });

const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
  captured.push({
    url: String(url),
    body: String(init?.body ?? ""),
    headers: Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    ),
  });
  return respondWith();
}) as unknown as typeof fetch;

const ALLOWED = "https://receiver.test/hooks/issuance";

/** Creates a tenant, a webhook endpoint and returns both plus the secret. */
const seedEndpoint = async () => {
  const tenantId = asId<"TenantId">(randomUUID());
  await harness.deps.db
    .insert(tables.tenants)
    .values({ id: tenantId, name: "Issuance webhook tenant", createdAt: harness.clock.now() });

  const endpointId = newWebhookEndpointId();
  const secret = newOpaqueToken(32);
  await harness.deps.repositories.webhookEndpoints.create({
    endpoint: {
      id: endpointId,
      tenantId,
      name: "Attestation Provider endpoint",
      callbackUrlAllowList: [ALLOWED],
      createdAt: harness.clock.now(),
    },
    secret,
  });
  return { tenantId, endpointId, secret };
};

beforeEach(async () => {
  harness ??= await createHarness({ fetchImpl });
  await harness.reset();
  captured.length = 0;
  respondWith = () => new Response("", { status: 200 });
});

afterAll(async () => {
  await harness?.close();
});

describe("issuance callbacks reuse the Milestone 1 delivery path", () => {
  it("signs an issuance payload with the endpoint's secret, verifiably", async () => {
    const { tenantId, endpointId, secret } = await seedEndpoint();
    const subjectId = randomUUID();

    await harness.deps.services.webhooks.enqueueEvent({
      tenantId,
      webhookEndpointId: endpointId,
      subjectType: "issuance",
      subjectId,
      url: ALLOWED,
      eventId: newWebhookEventId(),
      deliveryId: newWebhookDeliveryId(),
      payload: { event: "issuance.settled", issuanceId: subjectId, status: "ISSUED" },
      at: harness.clock.now(),
    });

    const result = await harness.deps.services.webhooks.deliverDue(
      asId<"CorrelationId">(randomUUID()),
    );
    expect(result.delivered).toBe(1);
    expect(captured).toHaveLength(1);

    const sent = captured[0];
    expect(sent?.url).toBe(ALLOWED);

    // The signature verifies against the **endpoint's** secret. That is the assertion that matters:
    // before the kernel change there was no secret an issuance could be signed with.
    const ok = verifyWebhookSignature({
      secret,
      body: sent?.body ?? "",
      signature: sent?.headers[SIGNATURE_HEADER] ?? "",
      timestamp: sent?.headers[TIMESTAMP_HEADER] ?? "",
      now: harness.clock.now(),
    });
    expect(ok, "the issuance callback must verify against the endpoint secret").toBe(true);

    // And not against a different secret, so the test could not pass by accident.
    expect(
      verifyWebhookSignature({
        secret: newOpaqueToken(32),
        body: sent?.body ?? "",
        signature: sent?.headers[SIGNATURE_HEADER] ?? "",
        timestamp: sent?.headers[TIMESTAMP_HEADER] ?? "",
        now: harness.clock.now(),
      }),
    ).toBe(false);
  });

  it("carries no attribute values and no status-list index in the payload", async () => {
    const { tenantId, endpointId } = await seedEndpoint();
    const subjectId = randomUUID();

    await harness.deps.services.webhooks.enqueueEvent({
      tenantId,
      webhookEndpointId: endpointId,
      subjectType: "issuance",
      subjectId,
      url: ALLOWED,
      eventId: newWebhookEventId(),
      deliveryId: newWebhookDeliveryId(),
      payload: {
        event: "issuance.settled",
        issuanceId: subjectId,
        status: "ISSUED",
        issuedCredentialId: randomUUID(),
      },
      at: harness.clock.now(),
    });
    await harness.deps.services.webhooks.deliverDue(asId<"CorrelationId">(randomUUID()));

    const body = captured[0]?.body ?? "";
    // The revocation index is an `ISSU_35` unique element: stored so revocation is possible, never
    // sent. Nor is any attribute value.
    for (const forbidden of [
      "statusListIndex",
      "status_list_index",
      "employee_id",
      "birthdate",
    ]) {
      expect(body, `payload must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("retries on a failing receiver, resending identical bytes under a fresh signature", async () => {
    const { tenantId, endpointId, secret } = await seedEndpoint();
    const subjectId = randomUUID();
    respondWith = () => new Response("nope", { status: 503 });

    await harness.deps.services.webhooks.enqueueEvent({
      tenantId,
      webhookEndpointId: endpointId,
      subjectType: "issuance",
      subjectId,
      url: ALLOWED,
      eventId: newWebhookEventId(),
      deliveryId: newWebhookDeliveryId(),
      payload: { event: "issuance.settled", issuanceId: subjectId, status: "ISSUED" },
      at: harness.clock.now(),
    });

    const first = await harness.deps.services.webhooks.deliverDue(
      asId<"CorrelationId">(randomUUID()),
    );
    expect(first.failed).toBe(1);
    expect(first.delivered).toBe(0);

    // The retry is scheduled with backoff, so advancing the clock is what makes it due.
    harness.clock.advance(120_000);
    respondWith = () => new Response("", { status: 200 });
    const second = await harness.deps.services.webhooks.deliverDue(
      asId<"CorrelationId">(randomUUID()),
    );
    expect(second.delivered).toBe(1);

    expect(captured).toHaveLength(2);

    // The **body** is byte-identical: the payload is stored once and resent, never rebuilt. A
    // rebuilt payload could differ in key order or a regenerated timestamp and would not verify.
    expect(captured[1]?.body).toBe(captured[0]?.body);

    // The **event id** is stable, so a receiver that already processed attempt 1 can deduplicate.
    expect(captured[1]?.headers[EVENT_ID_HEADER]).toBe(captured[0]?.headers[EVENT_ID_HEADER]);

    // The **signature differs**, and must: `signWebhookPayload` signs `timestamp.body`, so a retry
    // carries a fresh timestamp and therefore a fresh signature. Resending the original pair would
    // be a replayable message that a receiver enforcing a tolerance window would reject as stale.
    expect(captured[1]?.headers[TIMESTAMP_HEADER]).not.toBe(
      captured[0]?.headers[TIMESTAMP_HEADER],
    );
    expect(captured[1]?.headers[SIGNATURE_HEADER]).not.toBe(
      captured[0]?.headers[SIGNATURE_HEADER],
    );

    // And the retry's signature verifies on its own terms.
    expect(
      verifyWebhookSignature({
        secret,
        body: captured[1]?.body ?? "",
        signature: captured[1]?.headers[SIGNATURE_HEADER] ?? "",
        timestamp: captured[1]?.headers[TIMESTAMP_HEADER] ?? "",
        now: harness.clock.now(),
      }),
    ).toBe(true);
  });

  it("is idempotent: enqueueing the same event id twice delivers once", async () => {
    const { tenantId, endpointId } = await seedEndpoint();
    const subjectId = randomUUID();
    const eventId = newWebhookEventId();

    for (let i = 0; i < 2; i += 1) {
      await harness.deps.services.webhooks.enqueueEvent({
        tenantId,
        webhookEndpointId: endpointId,
        subjectType: "issuance",
        subjectId,
        url: ALLOWED,
        eventId,
        // A different delivery id each time, so only the event id can be what deduplicates.
        deliveryId: newWebhookDeliveryId(),
        payload: { event: "issuance.settled", issuanceId: subjectId, status: "ISSUED" },
        at: harness.clock.now(),
      });
    }

    const result = await harness.deps.services.webhooks.deliverDue(
      asId<"CorrelationId">(randomUUID()),
    );
    expect(result.delivered).toBe(1);
    expect(captured).toHaveLength(1);
  });

  it("gives up at the attempt cap and stops retrying", async () => {
    const { tenantId, endpointId } = await seedEndpoint();
    respondWith = () => new Response("", { status: 500 });

    await harness.deps.services.webhooks.enqueueEvent({
      tenantId,
      webhookEndpointId: endpointId,
      subjectType: "issuance",
      subjectId: randomUUID(),
      url: ALLOWED,
      eventId: newWebhookEventId(),
      deliveryId: newWebhookDeliveryId(),
      payload: { event: "issuance.settled", status: "ISSUED" },
      at: harness.clock.now(),
    });

    const maxAttempts = harness.config.WEBHOOK_MAX_ATTEMPTS;
    for (let i = 0; i < maxAttempts + 2; i += 1) {
      await harness.deps.services.webhooks.deliverDue(asId<"CorrelationId">(randomUUID()));
      harness.clock.advance(300_000);
    }

    // Exactly the cap, then nothing. An unbounded retry against a dead receiver is a denial of
    // service we would be mounting ourselves.
    expect(captured).toHaveLength(maxAttempts);
  });

  it("refuses to deliver when the endpoint's secret has gone, rather than signing with something else", async () => {
    const { tenantId, endpointId } = await seedEndpoint();

    await harness.deps.services.webhooks.enqueueEvent({
      tenantId,
      webhookEndpointId: endpointId,
      subjectType: "issuance",
      subjectId: randomUUID(),
      url: ALLOWED,
      eventId: newWebhookEventId(),
      deliveryId: newWebhookDeliveryId(),
      payload: { event: "issuance.settled", status: "ISSUED" },
      at: harness.clock.now(),
    });

    // Simulate the endpoint being removed mid-flight.
    await harness.deps.db.execute(
      `DELETE FROM webhook_endpoint_secrets WHERE endpoint_id = '${endpointId}'`,
    );

    const result = await harness.deps.services.webhooks.deliverDue(
      asId<"CorrelationId">(randomUUID()),
    );
    expect(result.failed).toBe(1);
    expect(captured, "nothing may be sent unsigned or mis-signed").toHaveLength(0);
  });
});
