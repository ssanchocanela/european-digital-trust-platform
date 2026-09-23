import type { SourceAttributes } from "@edtp/domain";

/**
 * Claim values waiting for the protocol engine, in a **wallet-initiated** issuance.
 *
 * In an offer the claims travel inside the offer. When the wallet starts from its own list of
 * issuers there is no offer: the wallet pushes an authorization request, the person fills in the
 * platform's hosted form, and the engine asks the platform for the values only when the wallet
 * requests the credential, seconds to minutes later. Something has to hold them in between, and this
 * is it.
 *
 * ## Why memory, and never a table
 *
 * They are content (ADR 0004): attribute values used for issuance, which `CLAUDE.md` §5 says are
 * never persisted. So they live in this process only, keyed by the wallet's opaque authorization
 * request reference, until the first of: the engine takes them — **once**, then they are gone — or
 * the transaction's lifetime ends. A platform restart loses them, and the person fills the form
 * again; that is the honest cost of not writing them down. V0 runs one platform process, so there
 * is no second instance to miss them (listed in `docs/security-limitations.md`).
 */
export interface HeldClaims {
  readonly tenantId: string;
  readonly issuanceId: string;
  readonly engineTenantRef: string;
  readonly claims: SourceAttributes;
  readonly expiresAt: Date;
}

export class WalletInitiatedClaims {
  private readonly held = new Map<string, HeldClaims>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Refuses a second hold for the same request: one authorization request, one attestation. */
  hold(requestUri: string, entry: HeldClaims): boolean {
    this.sweep();
    const key = keyOf(entry.engineTenantRef, requestUri);
    if (this.held.has(key)) return false;
    this.held.set(key, entry);
    return true;
  }

  /** Hands the values over and forgets them. */
  take(engineTenantRef: string, requestUri: string): HeldClaims | undefined {
    this.sweep();
    const key = keyOf(engineTenantRef, requestUri);
    const entry = this.held.get(key);
    this.held.delete(key);
    return entry;
  }

  get size(): number {
    this.sweep();
    return this.held.size;
  }

  private sweep(): void {
    const at = this.now().getTime();
    for (const [key, entry] of this.held) {
      if (entry.expiresAt.getTime() <= at) this.held.delete(key);
    }
  }
}

const keyOf = (engineTenantRef: string, requestUri: string): string =>
  `${engineTenantRef}\u0000${requestUri}`;
