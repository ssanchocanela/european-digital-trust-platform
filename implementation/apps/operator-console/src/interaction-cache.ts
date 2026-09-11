/**
 * The one piece of state the console holds, and why it has to.
 *
 * ## The constraint that forces it
 *
 * `POST /v1/presentations` returns the interaction URI. `GET /v1/presentations/{id}` **does not** — it
 * returns status, policy, expiry and result. So after the post-redirect-get that keeps a reload from
 * creating a second presentation, the URI is gone and the QR cannot be re-rendered.
 *
 * Three ways out, and two are worse:
 *
 * | | Why not |
 * |---|---|
 * | Render the page straight from the `POST` | A reload re-posts and creates a duplicate presentation — in a wallet test, a second live transaction nobody is watching |
 * | Put the URI in the redirect URL | `docs/web-interface-proposal.md` §3.1 keeps tokens and values out of URLs, which browsers keep in history and send in `Referer` |
 * | Hold it in memory for a few minutes | This. Bounded, expiring, and never written anywhere |
 *
 * **This corrects the proposal's claim that the console "stores nothing of its own".** It stores one
 * thing, in memory, for minutes. Said plainly here rather than left as a discrepancy.
 *
 * ## What it is not
 *
 * Not content. An interaction URI is a protocol artefact — a `request_uri` and a client id — and carries
 * no attribute value, so `CLAUDE.md` §5 is not in play. It is still treated as sensitive in the weaker
 * sense that it is a live capability to start a wallet interaction, which is why it expires and is never
 * logged.
 *
 * Not durable. A restart loses it, and the consequence is one page that cannot re-render a QR — start
 * another presentation. Single-instance, like the platform's background jobs (`security-limitations.md`
 * O1).
 */

export interface Interaction {
  readonly uri: string;
  readonly type: string;
}

interface Entry {
  readonly interaction: Interaction;
  readonly expiresAtMs: number;
}

/**
 * Ten minutes. Longer than any presentation the engine will keep alive for a test, short enough that a
 * console left running overnight holds nothing.
 */
const TTL_MS = 10 * 60 * 1_000;

/**
 * A cap, so a loop creating presentations cannot grow this without bound. Eviction is oldest-first; the
 * loss is cosmetic, and an unbounded map in a long-lived process is not.
 */
const MAX_ENTRIES = 200;

export class InteractionCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  set(presentationId: string, interaction: Interaction): void {
    this.prune();
    if (this.entries.size >= MAX_ENTRIES) {
      // `Map` preserves insertion order, so the first key is the oldest.
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(presentationId, {
      interaction,
      expiresAtMs: this.nowMs() + TTL_MS,
    });
  }

  get(presentationId: string): Interaction | undefined {
    const entry = this.entries.get(presentationId);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAtMs <= this.nowMs()) {
      this.entries.delete(presentationId);
      return undefined;
    }
    return entry.interaction;
  }

  /** Exposed for the tests, and for a future health page that wants to say how much is held. */
  get size(): number {
    this.prune();
    return this.entries.size;
  }

  private prune(): void {
    const now = this.nowMs();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= now) {
        this.entries.delete(key);
      }
    }
  }
}
