import { normaliseIssuanceOutcome } from "@edtp/eudiplo-adapter";
import { describe, expect, it } from "vitest";

/**
 * Engine issuance session states, as the engine actually sets them.
 *
 * There was no test here until 16 September 2026, which is how a comment asserting the wrong
 * meaning of `fetched` survived. Read against EUDIPLO 7.6.0's `Oid4vciService.getCredential`, the
 * engine issues and returns the credential and only then sets `fetched`; `completed` comes solely
 * from the Wallet's OPTIONAL notification. A Wallet that does not notify used to leave the platform
 * reporting `ISSUING` for an attestation that existed — and that it could therefore not revoke.
 */

const session = (status: string, extra: Record<string, unknown> = {}) =>
  ({ id: "s1", status, ...extra }) as unknown as Parameters<typeof normaliseIssuanceOutcome>[0];

describe("issuance session states", () => {
  it("reads `fetched` as ISSUED, because the credential was already returned", () => {
    const status = normaliseIssuanceOutcome(session("fetched"));
    expect(status.progress).toBe("SETTLED");
    expect(status.outcome).toBe("ISSUED");
  });

  it("reads `completed` as ISSUED too — the wallet also acknowledged it", () => {
    expect(normaliseIssuanceOutcome(session("completed")).outcome).toBe("ISSUED");
  });

  it("still refuses to call a `fetched` session with a failure code a success", () => {
    const status = normaliseIssuanceOutcome(
      session("fetched", { failureCode: "signature_invalid" }),
    );
    expect(status.progress).toBe("SETTLED");
    expect(status.outcome).not.toBe("ISSUED");
  });

  it("keeps `active` in progress — nothing has been issued yet", () => {
    const status = normaliseIssuanceOutcome(session("active"));
    expect(status.progress).toBe("AWAITING_WALLET");
    expect(status.outcome).toBeUndefined();
  });
});
