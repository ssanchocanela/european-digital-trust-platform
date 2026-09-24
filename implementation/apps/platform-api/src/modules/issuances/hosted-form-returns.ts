/**
 * Where a browser goes after the wallet has presented, when the presentation was started by the hosted
 * form.
 *
 * The wallet's same-device return lands on the platform's `…/presentations/{id}/return`, which for a
 * business client's presentation is a plain "you may go back" page. A presentation the hosted form
 * started — to identify a person before issuing them a representation — must lead back into the form.
 * The destination is built by the platform from its configured form origin when the presentation is
 * created, and looked up here by presentation id: nothing a visitor sends can choose it, so the return
 * route is not an open redirect. In memory, bounded by the presentation's lifetime.
 */
export class HostedFormReturns {
  private readonly entries = new Map<
    string,
    { readonly url: string; readonly expiresAt: Date }
  >();

  constructor(private readonly now: () => Date = () => new Date()) {}

  remember(presentationId: string, url: string, expiresAt: Date): void {
    this.sweep();
    this.entries.set(presentationId, { url, expiresAt });
  }

  destination(presentationId: string): string | undefined {
    this.sweep();
    return this.entries.get(presentationId)?.url;
  }

  private sweep(): void {
    const at = this.now().getTime();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt.getTime() <= at) this.entries.delete(id);
    }
  }
}
