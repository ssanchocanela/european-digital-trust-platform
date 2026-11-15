import {
  bannedWordsIn,
  issuanceObservation,
  NOT_A_CONFORMANCE_TEST,
  presentationObservation,
} from "@edtp/sandbox-domain";
import {
  NOT_A_CONFORMANCE_TEST as PORTAL_STATEMENT,
  planReportPage,
  walletTestsPage,
} from "@edtp/sandbox-portal/wallet-test-pages.js";
import { describe, expect, it } from "vitest";
import { WALLET_TEST_PLANS } from "../../apps/platform-api/src/modules/sandbox/wallet-test-plans.js";

/** Testing wallets (ADR 0022): what the server may say, and the words nothing may say. */
describe("the server's observation (ADR 0022 §3)", () => {
  it("calls every state in which data arrived 'presented', whatever the platform then did", () => {
    for (const s of [
      "VERIFIED",
      "REJECTED",
      "POLICY_NOT_SATISFIED",
      "TRUST_ERROR",
      "VERIFYING",
    ]) {
      expect(presentationObservation(s), s).toBe("presented");
    }
  });

  it("never turns silence into a refusal", () => {
    expect(presentationObservation("EXPIRED")).toBe("no_presentation");
    expect(issuanceObservation("EXPIRED")).toBe("no_collection");
    expect(presentationObservation("AWAITING_WALLET")).toBe("pending");
    expect(presentationObservation("DECLINED_BY_USER")).toBe("wallet_declined");
  });

  it("says a collected credential is collected, not kept", () => {
    expect(issuanceObservation("ISSUED")).toBe("credential_collected");
    expect(issuanceObservation("TRUST_ERROR")).toBe("issuer_refused_wallet");
  });
});

describe("the words (ADR 0022 §1)", () => {
  it("finds verdict words as whole words, and lets the fixed statement through", () => {
    expect(bannedWordsIn("The wallet passed")).toEqual(["passed"]);
    expect(bannedWordsIn("Conformant and certified")).toEqual(["conformant", "certified"]);
    expect(bannedWordsIn(`Fails the validity check. ${NOT_A_CONFORMANCE_TEST}`)).toEqual([]);
    expect(bannedWordsIn("passport")).toEqual([]);
  });

  it("keeps the portal's statement identical to the platform's", () => {
    expect(PORTAL_STATEMENT).toBe(NOT_A_CONFORMANCE_TEST);
  });

  it("puts no verdict word in any plan step", () => {
    for (const plan of WALLET_TEST_PLANS) {
      for (const step of plan.steps) {
        expect(bannedWordsIn(`${plan.title} ${step.title} ${step.asks}`), step.title).toEqual(
          [],
        );
      }
    }
  });

  it("puts no verdict word on the pages, and the statement on both", () => {
    const list = walletTestsPage({ orgId: "o", plans: [], runs: [], services: [] });
    const report = planReportPage("o", {
      planRun: "r",
      plan: { id: "p", version: 1, title: "Plan" },
      wallet: { provider: "W", build: "1", platform: "A" },
      createdAt: "2026-11-15T00:00:00Z",
      steps:
        WALLET_TEST_PLANS[0]?.steps.map((s, index) => ({
          index,
          title: s.title,
          requirement: s.requirement,
          asks: s.asks,
          started: true,
          server: "presented",
          tester: "refused_before_consent",
          observationsDisagree: true,
        })) ?? [],
    });
    for (const html of [list, report]) {
      expect(html).toContain(NOT_A_CONFORMANCE_TEST);
      expect(bannedWordsIn(html.replace(/<[^>]+>/g, " "))).toEqual([]);
    }
    expect(report).toContain("The two observations disagree.");
  });
});

describe("the plans (ADR 0022 §2)", () => {
  it("ship the three plans, with the registration defects on and off", () => {
    expect(WALLET_TEST_PLANS.map((p) => [p.id, p.steps.length])).toEqual([
      ["access-certificates", 7],
      ["registration-certificates", 23],
      ["issuance", 3],
    ]);
  });
});
