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
 * what a browser sends. What the browser does report is kept apart, because the page worked it out
 * and nobody verified it: which product the application is for, said when it starts so that a case
 * in progress can be told from another, and how it ended, as `declared`.
 */

export type Product = "cuenta" | "prestamo";

export interface DeclaredOutcome {
  readonly product: Product;
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
  /** What the page said the application is for, when it asked for the PID. */
  readonly product?: Product;
  /** Whether this application is to bring a second document: a loan's income certificate. */
  readonly expectsIncome: boolean;
  readonly identity: OnboardingData;
  readonly income?: IncomeData;
  readonly declared?: DeclaredOutcome;
}

export class CaseBook {
  private readonly cases = new Map<string, CaseRecord>();
  /** What was said of a PID presentation when it was asked for, until it is verified. */
  private readonly expected = new Map<string, { product: Product; expectsIncome: boolean }>();
  /** Which case an income presentation belongs to: its id, to the PID presentation's. */
  private readonly links = new Map<string, string>();

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

  private static keep<V>(map: Map<string, V>, key: string, value: V, max: number): void {
    if (map.size >= max) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, value);
  }

  /** A PID presentation has been asked for, and this is the application it is for. */
  expect(presentationId: string, product: Product, expectsIncome: boolean): void {
    CaseBook.keep(this.expected, presentationId, { product, expectsIncome }, this.max * 10);
  }

  /** An income presentation has been asked for, for the case this PID presentation opens. */
  link(incomePresentationId: string, pidPresentationId: string): void {
    CaseBook.keep(this.links, incomePresentationId, pidPresentationId, this.max * 10);
  }

  /** A verified PID opens a case. Polled again, the same presentation changes nothing. */
  identity(presentationId: string, identity: OnboardingData): void {
    this.sweep();
    if (this.cases.has(presentationId)) return;
    const said = this.expected.get(presentationId);
    this.expected.delete(presentationId);
    if (this.cases.size >= this.max) {
      const oldest = this.cases.keys().next().value;
      if (oldest !== undefined) this.cases.delete(oldest);
    }
    this.cases.set(presentationId, {
      reference: presentationId.slice(0, 8),
      openedAt: this.now(),
      ...(said ? { product: said.product } : {}),
      expectsIncome: said?.expectsIncome ?? false,
      identity,
    });
  }

  /** A verified income certificate, on the case its presentation was linked to. */
  income(incomePresentationId: string, income: IncomeData): boolean {
    const caseId = this.links.get(incomePresentationId);
    if (caseId === undefined) return false;
    return this.update(caseId, (record) => ({ ...record, income }));
  }

  /** How the page says the application ended. Declared, not verified. */
  declare(presentationId: string, declared: DeclaredOutcome): boolean {
    return this.update(presentationId, (record) => ({
      ...record,
      product: record.product ?? declared.product,
      declared,
    }));
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
