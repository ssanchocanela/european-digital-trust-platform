import type { NormalisedClaims, PresentationTransaction } from "@edtp/domain";
import type {
  DeliverySubjectType,
  RegistrationRepository,
  TransactionRepository,
  WebhookDeliveryRepository,
  WebhookEndpointRepository,
} from "@edtp/persistence";
import type {
  Clock,
  CorrelationId,
  WebhookDeliveryId,
  WebhookEndpointId,
  WebhookEventId,
} from "@edtp/shared";
import { asId } from "@edtp/shared";
import type { Logger } from "../logging/logger.js";
import {
  backoffDelayMs,
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  signWebhookPayload,
  TIMESTAMP_HEADER,
} from "./signing.js";

/**
 * Any event, for any subject.
 *
 * The generic entry point. `enqueueResult` below is the presentation-specific convenience that builds
 * the result payload; issuance uses this one directly. Both end up in the same queue, signed by the
 * same code, retried on the same schedule.
 */
export interface EnqueueEventInput {
  readonly tenantId: import("@edtp/shared").TenantId;
  readonly webhookEndpointId: WebhookEndpointId;
  readonly subjectType: DeliverySubjectType;
  readonly subjectId: string;
  readonly url: string;
  readonly eventId: WebhookEventId;
  readonly deliveryId: WebhookDeliveryId;
  readonly payload: Record<string, unknown>;
  readonly at: Date;
}

export interface EnqueueResultInput {
  readonly transaction: PresentationTransaction;
  readonly eventId: WebhookEventId;
  readonly deliveryId: WebhookDeliveryId;
  readonly claims?: NormalisedClaims;
  readonly at: Date;
}

/**
 * The result payload sent to a customer.
 *
 * Contains the normalised result only. No VP token, no credential, no disclosed claim
 * outside what the result policy emitted, and none of the `ISSU_35` unique elements — the
 * result policy stripped those before the value reached storage, and nothing here adds
 * them back.
 */
export interface ResultWebhookPayload {
  readonly eventId: string;
  readonly event: "presentation.settled";
  readonly presentationId: string;
  readonly businessReference: string;
  readonly status: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly settledAt: string;
  readonly result?: { readonly claims: NormalisedClaims };
  readonly failureCode?: string;
}

export interface WebhookServiceOptions {
  readonly maxAttempts: number;
  readonly timeoutMs: number;
}

export class WebhookService {
  constructor(
    private readonly deliveries: WebhookDeliveryRepository,
    private readonly transactions: TransactionRepository,
    private readonly registration: RegistrationRepository,
    private readonly endpoints: WebhookEndpointRepository,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: WebhookServiceOptions,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  /**
   * Queues the settled result for delivery.
   *
   * The payload is built and stored once; retries resend the identical bytes, because the
   * signature covers the body and a rebuilt payload would not verify. The `eventId` is
   * unique in the queue, so enqueueing twice is a no-op and a receiver can deduplicate.
   */
  /**
   * Queues any event for delivery.
   *
   * The payload is stored once; retries resend the identical bytes, because the signature covers the
   * body and a rebuilt payload would not verify. `eventId` is unique in the queue, so enqueueing
   * twice is a no-op and a receiver can deduplicate.
   */
  async enqueueEvent(input: EnqueueEventInput): Promise<void> {
    await this.deliveries.enqueue(
      {
        id: input.deliveryId,
        tenantId: input.tenantId,
        webhookEndpointId: input.webhookEndpointId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        eventId: input.eventId,
        url: input.url,
        payload: input.payload,
        attempt: 0,
        maxAttempts: this.options.maxAttempts,
        status: "PENDING",
        nextAttemptAt: input.at,
      },
      input.at,
    );
  }

  async enqueueResult(input: EnqueueResultInput): Promise<void> {
    const { transaction: tx } = input;
    if (!tx.callbackUrl) return;

    const payload: ResultWebhookPayload = {
      eventId: input.eventId,
      event: "presentation.settled",
      presentationId: tx.id,
      businessReference: tx.businessReference,
      status: tx.state,
      policyId: tx.policyId,
      policyVersion: tx.policyVersion,
      settledAt: (tx.closedAt ?? input.at).toISOString(),
      ...(input.claims ? { result: { claims: input.claims } } : {}),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    };

    // The endpoint is resolved from the Relying Party Service, which is where a presentation's
    // callback destination is configured. Everything after this point is subject-agnostic.
    const endpointId = await this.registration.findWebhookEndpointId(
      tx.tenantId,
      tx.relyingPartyServiceId,
    );
    if (!endpointId) {
      // Refused rather than signed with something else. A presentation whose Service has no endpoint
      // cannot have had a callback URL accepted in the first place, so this is a configuration change
      // mid-flight; the result stays readable through the API.
      this.logger.warn("no webhook endpoint is configured; result will not be delivered", {
        tenantId: tx.tenantId,
        presentationId: tx.id,
      });
      return;
    }

    await this.enqueueEvent({
      tenantId: tx.tenantId,
      webhookEndpointId: endpointId,
      subjectType: "presentation",
      subjectId: tx.id,
      url: tx.callbackUrl,
      eventId: input.eventId,
      deliveryId: input.deliveryId,
      payload: payload as unknown as Record<string, unknown>,
      at: input.at,
    });
  }

  /**
   * Delivers everything that is due.
   *
   * Returns the counts rather than throwing, because one failing receiver must not stop
   * the others.
   */
  async deliverDue(
    correlationId: CorrelationId,
  ): Promise<{ readonly delivered: number; readonly failed: number }> {
    const now = this.clock.now();
    const due = await this.deliveries.claimDue(now);
    let delivered = 0;
    let failed = 0;

    for (const record of due) {
      // One lookup, whatever the subject: the row names its endpoint, the endpoint holds the
      // secret. A delivery whose secret has gone is retried rather than dropped — the cause is
      // almost always a configuration change mid-flight, and silently discarding a customer's
      // notification would be worse.
      const secret = record.webhookEndpointId
        ? await this.endpoints.findSecret(record.webhookEndpointId)
        : undefined;

      if (!secret) {
        await this.deliveries.recordFailure(
          record.id,
          record.attempt,
          record.maxAttempts,
          new Date(now.getTime() + backoffDelayMs(record.attempt)),
          "no signing secret is configured for this webhook endpoint",
          now,
        );
        failed += 1;
        continue;
      }

      const signed = signWebhookPayload({
        secret,
        payload: record.payload,
        eventId: record.eventId,
        at: now,
      });

      try {
        const response = await this.fetchImpl(record.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SIGNATURE_HEADER]: signed.signature,
            [TIMESTAMP_HEADER]: signed.timestamp,
            [EVENT_ID_HEADER]: signed.eventId,
          },
          body: signed.body,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });

        if (!response.ok) {
          throw new Error(`receiver responded ${response.status}`);
        }

        await this.deliveries.markDelivered(record.id, now);
        // Presentation transactions track delivery separately from their outcome. An issuance
        // records nothing here: its delivery state lives on the queue row, which is enough, and
        // writing it back would mean a delivery failure touching an issuance's record.
        if (record.subjectType === "presentation") {
          await this.transactions.setDeliveryStatus(
            record.tenantId,
            asId<"PresentationId">(record.subjectId),
            "PENDING",
            "DELIVERED",
            now,
          );
        }
        delivered += 1;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "delivery failed";
        const nextAttempt = new Date(now.getTime() + backoffDelayMs(record.attempt));
        await this.deliveries.recordFailure(
          record.id,
          record.attempt,
          record.maxAttempts,
          nextAttempt,
          message,
          now,
        );
        if (record.attempt + 1 >= record.maxAttempts) {
          if (record.subjectType === "presentation") {
            await this.transactions.setDeliveryStatus(
              record.tenantId,
              asId<"PresentationId">(record.subjectId),
              "PENDING",
              "FAILED",
              now,
            );
          }
          // A failed delivery never changes the verification or issuance outcome: the result
          // remains readable through the API, and the queue row records that the push failed.
          this.logger.warn("webhook delivery exhausted its attempts", {
            correlationId,
            subjectType: record.subjectType,
            subjectId: record.subjectId,
            attempts: record.attempt + 1,
          });
        }
        failed += 1;
      }
    }

    return { delivered, failed };
  }
}
