import { createHmac, randomBytes } from "node:crypto";

/**
 * Banco Horizonte's customers: who opened an account in this demonstration, so that they can log in
 * with their wallet afterwards.
 *
 * The one thing a login presents is the personal administrative number, and the bank must recognise
 * it without keeping it. So a customer is keyed by an HMAC-SHA256 of the normalised number, under a
 * key generated when the process starts and never written anywhere: the number itself is hashed and
 * dropped in the request that carried it. Beside the digest the bank keeps what a bank would keep
 * of its own — the given name it greets, and the fictitious account — and nothing else from the PID.
 *
 * In memory, bounded, and gone on a restart or the nightly reset, like the back office. A new key on
 * every start also means a digest from one run matches nothing in the next.
 */

export interface Customer {
  readonly givenName: string;
  readonly iban: string;
  readonly since: Date;
}

/** What an account opening is waiting to finish: a verified PID, before the contract is signed. */
interface Pending {
  readonly digest: string;
  readonly givenName: string;
  readonly at: number;
}

const MAX_CUSTOMERS = 500;
const MAX_PENDING = 200;
const PENDING_MS = 60 * 60 * 1000;

/** Uppercase, with spaces, dots and hyphens dropped: `12345678-z` and `12345678Z` are one document. */
export const normaliseDocument = (value: string): string =>
  value.toUpperCase().replace(/[\s.-]/g, "");

export class CustomerBook {
  private readonly key = randomBytes(32);
  private readonly customers = new Map<string, Customer>();
  private readonly pending = new Map<string, Pending>();
  private issued = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private digest(document: string): string {
    return createHmac("sha256", this.key).update(normaliseDocument(document)).digest("hex");
  }

  /** Whether a document is already a customer's: an account opening that would be a second one. */
  isCustomer(document: string): boolean {
    return this.customers.has(this.digest(document));
  }

  /**
   * A verified PID for an account opening, held until the contract is signed. Keyed by the
   * presentation's id, which is what the page reports the signature against.
   */
  expect(presentationId: string, document: string, givenName: string): void {
    this.prune();
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(presentationId, {
      digest: this.digest(document),
      givenName,
      at: this.now(),
    });
  }

  /** The contract is signed: the person becomes a customer. Only a verified PID can have opened it. */
  enrol(presentationId: string): Customer | undefined {
    this.prune();
    const p = this.pending.get(presentationId);
    if (!p) return undefined;
    this.pending.delete(presentationId);
    const existing = this.customers.get(p.digest);
    if (existing) return existing;
    if (this.customers.size >= MAX_CUSTOMERS) {
      const oldest = this.customers.keys().next().value;
      if (oldest !== undefined) this.customers.delete(oldest);
    }
    this.issued += 1;
    const customer: Customer = {
      givenName: p.givenName,
      iban: fictitiousIban(this.issued),
      since: new Date(this.now()),
    };
    this.customers.set(p.digest, customer);
    return customer;
  }

  /** The customer a login presented, if the bank has one. The document is not kept. */
  find(document: string): Customer | undefined {
    return this.customers.get(this.digest(document));
  }

  private prune(): void {
    const limit = this.now() - PENDING_MS;
    for (const [id, p] of this.pending) if (p.at < limit) this.pending.delete(id);
  }
}

/** A fictitious IBAN in the shape of a Spanish one, under bank code 0000, which no bank holds. */
const fictitiousIban = (n: number): string =>
  `ES00 0000 0000 00${String(n).padStart(10, "0")}`.replace(
    /(\d{4})(\d{4})(\d{4})$/,
    "$1 $2 $3",
  );
