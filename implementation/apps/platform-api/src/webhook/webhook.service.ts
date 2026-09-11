import type { NormalisedClaims, PresentationTransaction } from "@edtp/domain";
import type {
  RegistrationRepository,
  TransactionRepository,
  WebhookDeliveryRepository,
} from "@edtp/persistence";
import type { Clock, CorrelationId, WebhookDeliveryId, WebhookEventId } from "@edtp/shared";
import type { Logger } from "../logging/logger.js";
import {
  backoffDelayMs,
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  signWebhookPayload,
  TIMESTAMP_HEADER,
} from "./signing.js";

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

    await this.deliveries.enqueue(
      {
        id: input.deliveryId,
        tenantId: tx.tenantId,
        presentationId: tx.id,
        eventId: input.eventId,
        url: tx.callbackUrl,
        payload: payload as unknown as Record<string, unknown>,
        attempt: 0,
        maxAttempts: this.options.maxAttempts,
        status: "PENDING",
        nextAttemptAt: input.at,
      },
      input.at,
    );
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
      // The signing secret belongs to the Relying Party Service, so the transaction is
      // the route to it. A delivery whose transaction or secret has gone is retried
      // rather than dropped: the cause is almost always a configuration change mid-flight,
      // and silently discarding a customer's result notification would be worse.
      const tx = await this.transactions.find(record.tenantId, record.presentationId);
      const secret = tx
        ? await this.registration.findWebhookSecret(record.tenantId, tx.relyingPartyServiceId)
        : undefined;

      if (!tx || !secret) {
        await this.deliveries.recordFailure(
          record.id,
          record.attempt,
          record.maxAttempts,
          new Date(now.getTime() + backoffDelayMs(record.attempt)),
          tx
            ? "no signing secret is configured for the Relying Party Service"
            : "the presentation transaction for this delivery no longer exists",
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
        await this.transactions.setDeliveryStatus(
          record.tenantId,
          record.presentationId,
          "PENDING",
          "DELIVERED",
          now,
        );
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
          await this.transactions.setDeliveryStatus(
            record.tenantId,
            record.presentationId,
            "PENDING",
            "FAILED",
            now,
          );
          // A failed delivery never changes the verification outcome: the result remains
          // readable through the API, and `deliveryStatus` records that the push failed.
          this.logger.warn("webhook delivery exhausted its attempts", {
            correlationId,
            presentationId: record.presentationId,
            attempts: record.attempt + 1,
          });
        }
        failed += 1;
      }
    }

    return { delivered, failed };
  }
}
