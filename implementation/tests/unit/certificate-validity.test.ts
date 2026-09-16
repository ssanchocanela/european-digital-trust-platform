import { generateKeyPairSync } from "node:crypto";
import { PlatformError } from "@edtp/shared";
import { describe, expect, it } from "vitest";
import { certificateChainNotAfter } from "../../apps/platform-api/src/http/certificate-validity.js";
import { selfSignedCertificate } from "../support/self-signed.js";

/**
 * Reading a supplied certificate's expiry.
 *
 * The platform holds no key material — a certificate goes into the engine and what comes back is an
 * opaque reference — so this one date is everything it knows about whether a provider can still
 * sign. On 16 September 2026 it knew nothing, and the answer had been *no* for a day.
 */

const keyPem = () =>
  generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;

describe("certificateChainNotAfter", () => {
  it("reads the expiry of the leaf, which is the certificate that signs", () => {
    const notAfter = new Date(Date.now() + 30 * 86_400_000);
    const leaf = selfSignedCertificate(keyPem(), "edtp-validity-test", {
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter,
    });

    const read = certificateChainNotAfter([leaf], "attestation-signing certificate");

    // Second precision: X.509 carries no milliseconds.
    expect(Math.abs(read.getTime() - notAfter.getTime())).toBeLessThan(1000);
  });

  it("reads index 0, not the anchor, because chains are supplied leaf-first", () => {
    const leafNotAfter = new Date(Date.now() + 10 * 86_400_000);
    const leaf = selfSignedCertificate(keyPem(), "edtp-leaf", {
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter: leafNotAfter,
    });
    const anchor = selfSignedCertificate(keyPem(), "edtp-anchor", {
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter: new Date(Date.now() + 900 * 86_400_000),
    });

    const read = certificateChainNotAfter([leaf, anchor], "access certificate");

    expect(Math.abs(read.getTime() - leafNotAfter.getTime())).toBeLessThan(1000);
  });

  it("reads a date in the past without complaint — an expired certificate is a fact, not an error", () => {
    // The caller decides what an expired certificate means. This function only reports when it
    // stopped working, so that a report can say `expired: true` instead of saying nothing, which is
    // the failure this whole change exists to fix.
    const notAfter = new Date(Date.now() - 86_400_000);
    const leaf = selfSignedCertificate(keyPem(), "edtp-expired", {
      notBefore: new Date(Date.now() - 3 * 86_400_000),
      notAfter,
    });

    const read = certificateChainNotAfter([leaf], "attestation-signing certificate");

    expect(read.getTime()).toBeLessThan(Date.now());
    expect(Math.abs(read.getTime() - notAfter.getTime())).toBeLessThan(1000);
  });

  it("refuses an empty chain, naming which certificate and the expected order", () => {
    try {
      certificateChainNotAfter([], "attestation-signing certificate");
      expect.unreachable("an empty chain must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe("certificate_chain_empty");
      expect((error as PlatformError).message).toContain("attestation-signing certificate");
      expect((error as PlatformError).message).toContain("leaf-first");
    }
  });

  it("refuses unreadable material without echoing it back", () => {
    const secretLooking = "-----BEGIN CERTIFICATE-----\nnot-a-certificate-at-all\n";
    try {
      certificateChainNotAfter([secretLooking], "access certificate");
      expect.unreachable("unreadable material must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe("certificate_unreadable");
      // Supplied material never comes back in an error message. It is still supplied material.
      expect((error as PlatformError).message).not.toContain("not-a-certificate-at-all");
      expect((error as PlatformError).message).toContain("access certificate");
    }
  });
});
