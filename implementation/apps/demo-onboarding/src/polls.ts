import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Which presentations were asked for cross-device, and the token their outcome is released for.
 *
 * A `QR` presentation returns nothing to the device that scanned it; the browser that showed the
 * code reads the outcome here. The presentation id alone must not be enough for that, so the browser
 * gets a token no one else sees. Bounded, in memory: a restart forgets it, and the presentations it
 * knew of — two minutes long — expire unread.
 */
export class CrossDevicePolls {
  private readonly ids = new Map<string, Buffer>();
  private readonly key = randomBytes(32);

  constructor(private readonly max = 2_000) {}

  private mac(id: string): Buffer {
    return createHmac("sha256", this.key).update(id).digest();
  }

  remember(id: string): string {
    if (this.ids.size >= this.max) {
      const oldest = this.ids.keys().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    const mac = this.mac(id);
    this.ids.set(id, mac);
    return mac.toString("base64url");
  }

  /** True for a same-device presentation, and for a cross-device one with its token. */
  allows(id: string, token: string | undefined): boolean {
    const expected = this.ids.get(id);
    if (!expected) return true;
    const presented = Buffer.from(token ?? "", "base64url");
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }
}
