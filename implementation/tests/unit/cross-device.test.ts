import {
  type AccessCertificate,
  applyCrossDeviceMitigations,
  CROSS_DEVICE_MITIGATIONS,
  CROSS_DEVICE_RESIDUAL_RISKS,
  defaultRetentionPolicy,
  QR_MAX_TRANSACTION_LIFETIME_SECONDS,
} from "@edtp/domain";
import { asId } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/**
 * Cross-device mitigations for the redirect-based QR flow.
 *
 * `EW-PIO-01-017` (`OIA_08d`) obliges a Relying Party that uses a redirect-based cross-device
 * flow to mitigate the challenges in ARF §4.4.3.2 — the section `OIA_08d` mis-cites as §4.4.3.1.
 * Two of the five challenges are addressable by a Relying Party, one partly, two not at all, so
 * these tests assert both what is mitigated **and** what is honestly left residual.
 */
const at = new Date("2026-09-11T08:00:00Z");

const accessCertificate = (notAfter?: Date): AccessCertificate => ({
  id: asId<"AccessCertificateId">("88888888-8888-8888-8888-888888888888"),
  tenantId: asId<"TenantId">("22222222-2222-2222-2222-222222222222"),
  relyingPartyId: asId<"RelyingPartyId">("44444444-4444-4444-4444-444444444444"),
  relyingPartyServiceId: asId<"RelyingPartyServiceId">("33333333-3333-3333-3333-333333333333"),
  keyBindingRef: "key-chain-1",
  ...(notAfter ? { notAfter } : {}),
  trustEnvironment: "TEST",
  createdAt: at,
});

describe("applyCrossDeviceMitigations", () => {
  it("caps the transaction lifetime below the same-device default", () => {
    // Challenge 1: no OS proximity check is available in a custom-URI flow, so the only thing a
    // Relying Party can shrink is the window in which a phished or relayed URI is still usable.
    const decision = applyCrossDeviceMitigations({
      retentionPolicy: defaultRetentionPolicy(),
      accessCertificate: accessCertificate(),
      at,
    });

    expect(defaultRetentionPolicy().transactionLifetimeSeconds).toBeGreaterThan(
      QR_MAX_TRANSACTION_LIFETIME_SECONDS,
    );
    expect(decision.transactionLifetimeSeconds).toBe(QR_MAX_TRANSACTION_LIFETIME_SECONDS);
    expect(decision.lifetimeCapped).toBe(true);
  });

  it("leaves an already-short lifetime alone rather than extending it", () => {
    const decision = applyCrossDeviceMitigations({
      retentionPolicy: { transactionLifetimeSeconds: 90, resultRetentionSeconds: 3_600 },
      accessCertificate: accessCertificate(),
      at,
    });
    expect(decision.transactionLifetimeSeconds).toBe(90);
    expect(decision.lifetimeCapped).toBe(false);
  });

  it("refuses when the access certificate would expire inside the transaction", () => {
    // Challenge 4: a redirect flow has no browser-supplied origin, so the signed request object
    // is the only way a Wallet can attribute the request. Letting it go live with a certificate
    // that lapses mid-flight would leave part of its life unattributable.
    expect(() =>
      applyCrossDeviceMitigations({
        retentionPolicy: defaultRetentionPolicy(),
        accessCertificate: accessCertificate(new Date(at.getTime() + 30_000)),
        at,
      }),
    ).toThrowError(/remain valid for the whole transaction lifetime/i);
  });

  it("accepts a certificate that outlives the capped lifetime", () => {
    const decision = applyCrossDeviceMitigations({
      retentionPolicy: defaultRetentionPolicy(),
      accessCertificate: accessCertificate(
        new Date(at.getTime() + (QR_MAX_TRANSACTION_LIFETIME_SECONDS + 60) * 1000),
      ),
      at,
    });
    expect(decision.transactionLifetimeSeconds).toBe(QR_MAX_TRANSACTION_LIFETIME_SECONDS);
  });

  it("reports the residual risks, so OIA_08d is never implied to be satisfied", () => {
    const decision = applyCrossDeviceMitigations({
      retentionPolicy: defaultRetentionPolicy(),
      accessCertificate: accessCertificate(),
      at,
    });

    // The two challenges no Relying Party can address with custom URIs, plus the parts of
    // challenges 1 and 4 that need the browser and OS.
    expect(decision.residualRisks).toContain("NO_PROXIMITY_CHECK");
    expect(decision.residualRisks).toContain("NO_UNIFIED_WALLET_SELECTION");
    expect(decision.residualRisks).toContain("INCONSISTENT_INVOCATION");
    expect(decision.residualRisks).toContain("NO_BROWSER_SUPPLIED_ORIGIN");
    expect(decision.residualRisks).toHaveLength(CROSS_DEVICE_RESIDUAL_RISKS.length);
  });

  it("names every mitigation it applied", () => {
    const decision = applyCrossDeviceMitigations({
      retentionPolicy: defaultRetentionPolicy(),
      accessCertificate: accessCertificate(),
      at,
    });
    expect(decision.mitigationsApplied).toEqual(CROSS_DEVICE_MITIGATIONS);
    expect(decision.mitigationsApplied).toContain("QR_SHORT_LIFETIME");
    expect(decision.mitigationsApplied).toContain("QR_REQUESTER_AUTHENTICATED");
    expect(decision.mitigationsApplied).toContain("QR_NO_RESULT_VIA_INTERACTION_CHANNEL");
    expect(decision.mitigationsApplied).toContain("QR_EXPLICIT_OPT_IN_AUDITED");
  });

  it("keeps the residual set non-empty, so the honest limitation cannot be quietly removed", () => {
    // If a future change emptied this, the platform would start implying it had satisfied
    // `OIA_08d`. Only the W3C Digital Credentials API can close these.
    expect(CROSS_DEVICE_RESIDUAL_RISKS.length).toBeGreaterThan(0);
  });
});
