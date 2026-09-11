import {
  ENGINE_FAILURE_CODES,
  isKnownFailureCode,
  normaliseOutcome,
  progressFor,
} from "@edtp/eudiplo-adapter";
import { describe, expect, it } from "vitest";

/**
 * Engine outcome normalisation.
 *
 * The governing fact is that the engine's coarse session status is **not decidable**:
 * `failed` covers trust failures, signature failures and protocol failures alike. So the
 * adapter branches on the machine-readable failure code the engine added in v7.5.0 —
 * ADR 0002 Decision 4. Pinning an earlier release would have forced classification back
 * onto the status, which is exactly what these tests show is impossible to do correctly.
 */
describe("progressFor", () => {
  it("treats a fetched request as still awaiting the wallet", () => {
    // The wallet has collected the request object but has not responded, which from the
    // platform's point of view is indistinguishable from waiting.
    expect(progressFor("active")).toBe("AWAITING_WALLET");
    expect(progressFor("fetched")).toBe("AWAITING_WALLET");
  });

  it("treats completed, expired and failed as settled", () => {
    expect(progressFor("completed")).toBe("SETTLED");
    expect(progressFor("expired")).toBe("SETTLED");
    expect(progressFor("failed")).toBe("SETTLED");
  });

  it("degrades an unrecognised status to awaiting rather than settling it", () => {
    // A status the adapter has never seen must not be read as a terminal outcome: that
    // would settle a transaction on a guess.
    expect(progressFor("some-new-engine-status")).toBe("AWAITING_WALLET");
  });
});

describe("normaliseOutcome", () => {
  it("returns no outcome while the flow is still open", () => {
    const result = normaliseOutcome({ status: "active" });
    expect(result.progress).toBe("AWAITING_WALLET");
    expect(result.outcome).toBeUndefined();
  });

  it("maps a clean completion to VERIFIED", () => {
    const result = normaliseOutcome({ status: "completed", outcomeResult: "success" });
    expect(result.outcome).toBe("VERIFIED");
  });

  it("maps a completion whose policy was not satisfied to POLICY_NOT_SATISFIED", () => {
    // Whether the policy is satisfied is the platform's own question, answered after the
    // result policy runs; the engine has no view of it.
    const result = normaliseOutcome({
      status: "completed",
      outcomeResult: "success",
      policySatisfied: false,
    });
    expect(result.outcome).toBe("POLICY_NOT_SATISFIED");
  });

  it("maps credential defects to REJECTED", () => {
    for (const code of ["signature_invalid", "certificate_expired", "x5c_missing"]) {
      const result = normaliseOutcome({ status: "failed", failureCode: code });
      expect(result.outcome, code).toBe("REJECTED");
      expect(result.failureCode).toBe(code);
    }
  });

  it("maps trust-chain failures to TRUST_ERROR, not REJECTED", () => {
    // The credential may be perfectly valid under a trust configuration we do not hold, so
    // calling it rejected would misreport it.
    for (const code of ["no_trust_chain_to_root", "trust_chain_not_trusted"]) {
      const result = normaliseOutcome({ status: "failed", failureCode: code });
      expect(result.outcome, code).toBe("TRUST_ERROR");
      expect(result.verifierSideFailure).toBeUndefined();
    }
  });

  it("flags trust_list_unavailable as a verifier-side failure", () => {
    // The engine documents this as our own misconfiguration or outage rather than a defect
    // in the presented credential, and keeps it distinct from `trust_chain_not_trusted` so
    // operators can tell the two apart. The platform must not report it as a bad credential.
    const result = normaliseOutcome({
      status: "failed",
      failureCode: "trust_list_unavailable",
    });
    expect(result.outcome).toBe("TRUST_ERROR");
    expect(result.verifierSideFailure).toBe(true);
  });

  it("maps an OpenID4VP access_denied to DECLINED_BY_USER", () => {
    const result = normaliseOutcome({ status: "failed", failureCode: "access_denied" });
    expect(result.outcome).toBe("DECLINED_BY_USER");
  });

  it("maps the generic verification_error to PROTOCOL_ERROR", () => {
    const result = normaliseOutcome({ status: "failed", failureCode: "verification_error" });
    expect(result.outcome).toBe("PROTOCOL_ERROR");
  });

  it("maps an expired engine session to EXPIRED", () => {
    expect(normaliseOutcome({ status: "expired" }).outcome).toBe("EXPIRED");
  });

  it("degrades an unknown failure code to PROTOCOL_ERROR while keeping the raw code", () => {
    // A new engine failure code must fail safely and visibly rather than be silently
    // misclassified as something more specific.
    const result = normaliseOutcome({
      status: "failed",
      failureCode: "some_future_engine_code",
    });
    expect(result.outcome).toBe("PROTOCOL_ERROR");
    expect(result.failureCode).toBe("some_future_engine_code");
  });

  it("falls back to the structured outcome's error when failureCode is absent", () => {
    const result = normaliseOutcome({
      status: "failed",
      outcomeResult: "failed",
      outcomeError: "trust_chain_not_trusted",
    });
    expect(result.outcome).toBe("TRUST_ERROR");
  });

  it("does not read a bare failed status as VERIFIED", () => {
    // The crux: `failed` with no code at all must never resolve to success.
    const result = normaliseOutcome({ status: "failed" });
    expect(result.outcome).toBe("PROTOCOL_ERROR");
  });

  it("carries the short message through but never fabricates one", () => {
    const withMessage = normaliseOutcome({
      status: "failed",
      failureCode: "trust_chain_not_trusted",
      message: "The credential issuer is not in the trusted list.",
    });
    expect(withMessage.failureMessage).toBe(
      "The credential issuer is not in the trusted list.",
    );

    const withoutMessage = normaliseOutcome({
      status: "failed",
      failureCode: "signature_invalid",
    });
    expect(withoutMessage.failureMessage).toBeUndefined();
  });
});

describe("isKnownFailureCode", () => {
  it("recognises every code in the engine taxonomy plus the wallet denial", () => {
    for (const code of ENGINE_FAILURE_CODES) {
      expect(isKnownFailureCode(code), code).toBe(true);
    }
    expect(isKnownFailureCode("access_denied")).toBe(true);
    expect(isKnownFailureCode("not_a_real_code")).toBe(false);
  });
});
