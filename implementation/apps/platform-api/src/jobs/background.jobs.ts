import type { TransactionRepository } from "@edtp/persistence";
import type { Clock } from "@edtp/shared";
import { newCorrelationId } from "@edtp/shared";
import type { Logger } from "../logging/logger.js";
import type { PresentationService } from "../modules/presentations/presentation.service.js";
import type { WebhookService } from "../webhook/webhook.service.js";

/**
 * Background jobs.
 *
 * Three responsibilities, all of which must happen without a request to drive them:
 *
 * 1. **Expiry.** A transaction nobody polls must still reach `EXPIRED`, or it would sit
 *    open forever and its engine session would be reaped underneath it.
 * 2. **Result retention.** Normalised results are deleted once their retention window
 *    elapses, while transaction metadata and the audit trail survive — so evidence that a
 *    verification happened outlives the values, which is the point of separating the data
 *    classes (ADR 0004).
 * 3. **Webhook delivery.** Retries with bounded exponential backoff.
 *
 * A single interval timer runs all three in sequence rather than three competing timers:
 * at V0 volumes the work is trivial, and one timer makes the ordering and the failure
 * behaviour obvious.
 */
export class BackgroundJobs {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly presentations: PresentationService,
    private readonly webhooks: WebhookService,
    private readonly transactions: TransactionRepository,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    // Do not hold the event loop open on shutdown.
    this.timer.unref();
    this.logger.info("background jobs started", { intervalMs: this.intervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One pass. Exposed so tests drive it deterministically instead of waiting on a timer.
   *
   * Re-entrancy is guarded: a slow pass must not overlap with the next tick, or two passes
   * would compete for the same due rows.
   */
  async runOnce(): Promise<{
    readonly expired: number;
    readonly purgedResults: number;
    readonly delivered: number;
    readonly failedDeliveries: number;
  }> {
    if (this.running) {
      return { expired: 0, purgedResults: 0, delivered: 0, failedDeliveries: 0 };
    }
    this.running = true;
    const correlationId = newCorrelationId();
    const log = this.logger.child({ correlationId, job: "background" });

    let expired = 0;
    let purgedResults = 0;
    let delivered = 0;
    let failedDeliveries = 0;

    try {
      // Each step is isolated: a failure in one must not stop the others, because they
      // are unrelated responsibilities that happen to share a timer.
      try {
        expired = await this.presentations.expireDue(correlationId);
      } catch (error) {
        log.error("expiry pass failed", { errorName: errorName(error) });
      }

      try {
        purgedResults = await this.transactions.purgeExpiredResults(this.clock.now());
      } catch (error) {
        log.error("result purge failed", { errorName: errorName(error) });
      }

      try {
        const outcome = await this.webhooks.deliverDue(correlationId);
        delivered = outcome.delivered;
        failedDeliveries = outcome.failed;
      } catch (error) {
        log.error("webhook delivery pass failed", { errorName: errorName(error) });
      }

      if (expired + purgedResults + delivered + failedDeliveries > 0) {
        log.info("background pass completed", {
          expired,
          purgedResults,
          delivered,
          failedDeliveries,
        });
      }
    } finally {
      this.running = false;
    }

    return { expired, purgedResults, delivered, failedDeliveries };
  }
}

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error;
