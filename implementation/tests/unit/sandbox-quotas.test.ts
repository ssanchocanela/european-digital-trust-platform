import { quotaReached, SANDBOX_QUOTAS } from "@edtp/sandbox-domain";
import { describe, expect, it } from "vitest";

describe("sandbox quotas", () => {
  it("carries the specification's engine-tenant quotas: 3 hosted verifiers and 1 hosted issuer", () => {
    expect(SANDBOX_QUOTAS.hostedVerifiersPerOrganisation).toBe(3);
    expect(SANDBOX_QUOTAS.hostedIssuersPerOrganisation).toBe(1);
  });

  it("refuses the one that would exceed a quota, and not the one before", () => {
    expect(quotaReached("hostedIssuersPerOrganisation", 0)).toBe(false);
    expect(quotaReached("hostedIssuersPerOrganisation", 1)).toBe(true);
    expect(quotaReached("certificatesPerServicePerDay", 99)).toBe(false);
    expect(quotaReached("certificatesPerServicePerDay", 100)).toBe(true);
  });
});
