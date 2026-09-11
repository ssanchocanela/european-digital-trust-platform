import type { AuditRepository } from "@edtp/persistence";
import type { Clock, TenantId } from "@edtp/shared";
import { newAuditEventId } from "@edtp/shared";

export interface RecordAuditInput {
  readonly tenantId: TenantId;
  readonly actor: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId?: string;
  readonly policyId?: string;
  readonly policyVersion?: number;
  readonly outcome?: string;
  readonly correlationId?: string;
  readonly detail?: Record<string, unknown>;
}

/**
 * Audit evidence.
 *
 * Records *that* something happened, under which policy version, with what outcome — never
 * what was disclosed. `detail` is redacted by the repository before it is written, using
 * the same deny-list the logger uses, so an audit row cannot become a second content
 * store.
 */
export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly clock: Clock,
  ) {}

  async record(input: RecordAuditInput): Promise<void> {
    await this.repository.record({
      id: newAuditEventId(),
      at: this.clock.now(),
      ...input,
    });
  }

  async listForPresentation(tenantId: TenantId, presentationId: string) {
    return this.repository.listForSubject(tenantId, "presentation", presentationId);
  }
}
