import type { IncomeData, OnboardingData } from "./claims.js";

/**
 * The back office's case book: what Banco Horizonte's fictitious staff see of the applications
 * that came in.
 *
 * **It holds what a wallet presented.** That is a change from a page that kept nothing, and it is
 * bounded on purpose: in the memory of this one process, a handful of cases, each gone after half an
 * hour and all of them at a restart. No file, no database, no log. It exists only while the back
 * office is switched on, and the back office is served only behind Cloudflare Access.
 *
 * The verified values are written here by the server, from the platform's own answer — never from
 * what a browser sends. What the browser does report, the product and how the application ended, is
 * kept apart as `declared`, because the page worked it out and nobody verified it.
 */

export interface DeclaredOutcome {
  readonly product: "cuenta" | "prestamo";
  readonly signed: boolean;
  /** A loan's terms, as the page computed them. */
  readonly amount?: number;
  readonly months?: number;
  readonly granted?: number;
  readonly monthlyPayment?: number;
}

export interface CaseRecord {
  /** The first eight characters of the PID presentation's id: enough to tell cases apart. */
  readonly reference: string;
  readonly openedAt: Date;
  readonly identity: OnboardingData;
  readonly income?: IncomeData;
  readonly declared?: DeclaredOutcome;
}

export class CaseBook {
  private readonly cases = new Map<string, CaseRecord>();

  constructor(
    private readonly max = 20,
    private readonly ttlMs = 30 * 60_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private sweep(): void {
    const limit = this.now().getTime() - this.ttlMs;
    for (const [id, record] of this.cases) {
      if (record.openedAt.getTime() <= limit) this.cases.delete(id);
    }
  }

  /** A verified PID opens a case. Polled again, the same presentation changes nothing. */
  identity(presentationId: string, identity: OnboardingData): void {
    this.sweep();
    if (this.cases.has(presentationId)) return;
    if (this.cases.size >= this.max) {
      const oldest = this.cases.keys().next().value;
      if (oldest !== undefined) this.cases.delete(oldest);
    }
    this.cases.set(presentationId, {
      reference: presentationId.slice(0, 8),
      openedAt: this.now(),
      identity,
    });
  }

  /** A verified income certificate, on the case its PID presentation opened. */
  income(presentationId: string, income: IncomeData): boolean {
    return this.update(presentationId, (record) => ({ ...record, income }));
  }

  /** How the page says the application ended. Declared, not verified. */
  declare(presentationId: string, declared: DeclaredOutcome): boolean {
    return this.update(presentationId, (record) => ({ ...record, declared }));
  }

  private update(id: string, change: (record: CaseRecord) => CaseRecord): boolean {
    this.sweep();
    const record = this.cases.get(id);
    if (!record) return false;
    this.cases.set(id, change(record));
    return true;
  }

  /** Newest first. */
  list(): readonly CaseRecord[] {
    this.sweep();
    return [...this.cases.values()].reverse();
  }
}
