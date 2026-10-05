import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIELDS,
  isAdult,
  REQUESTED_CLAIMS,
  toOnboardingData,
} from "../../apps/demo-onboarding/src/claims.js";
import { CLIENT_JS } from "../../apps/demo-onboarding/src/client.js";
import { DICTIONARIES, dictionary } from "../../apps/demo-onboarding/src/i18n.js";
import {
  affordableAmount,
  LOAN_TERMS,
  monthlyPayment,
} from "../../apps/demo-onboarding/src/loan.js";
import {
  CONTENT_SECURITY_POLICY,
  renderPlain,
  renderShell,
} from "../../apps/demo-onboarding/src/page.js";
import { CrossDevicePolls } from "../../apps/demo-onboarding/src/polls.js";
import { RECORDED_CLAIMS } from "../../apps/demo-onboarding/src/recorded.js";

/**
 * Banco Horizonte, the bank onboarding demonstration. A fictitious bank, so the band is on every
 * page; it shows values a wallet presented, so nothing is parsed as markup; and what it asks a PID
 * for is exactly what its policy registers.
 */
const { t } = dictionary("es");
const shell = (extra: { resume?: string; recorded?: unknown } = {}) =>
  renderShell({ lang: "es", t, assets: "assets/abc", live: true, recorded: {}, ...extra });

describe("Banco Horizonte pages", () => {
  it("carry the demonstration band, and never claim to be a real bank", () => {
    for (const page of [shell(), renderPlain(t, "No encontrado", "x", "/assets/abc")]) {
      expect(page).toContain("Entorno de demostración");
      expect(page).toContain("no es un banco real");
    }
  });

  it("name no real bank", () => {
    expect(`${shell()}${JSON.stringify(DICTIONARIES)}${CLIENT_JS}`).not.toMatch(/caixa/i);
  });

  it("allow no inline script and no foreign origin", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
    expect(shell()).not.toMatch(/<script(?![^>]*(type="application\/json"|src=))/);
  });

  it("cannot be broken out of by a value in a data block", () => {
    const page = shell({ recorded: { x: "</script><script>alert(1)</script>" } });
    expect(page).not.toContain("</script><script>alert(1)");
  });

  it("build screens from text, never from markup", () => {
    expect(CLIENT_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe("what the bank asks the PID for", () => {
  const definition = JSON.parse(
    readFileSync(resolve(__dirname, "../../scripts/onboarding/bank-onboarding.json"), "utf8"),
  ) as { policy: { requestedClaims: string[][] } };

  it("is exactly what its policy requests", () => {
    expect(REQUESTED_CLAIMS).toEqual(definition.policy.requestedClaims);
  });

  it("never asks for an age claim: the PID has none", () => {
    expect(JSON.stringify(REQUESTED_CLAIMS)).not.toMatch(/age_/);
  });

  it("has a label for every field, in every language", () => {
    for (const d of Object.values(DICTIONARIES)) {
      for (const f of FIELDS) expect(d[f.label as keyof typeof d]).toBeTruthy();
      expect(Object.keys(d).sort()).toEqual(Object.keys(DICTIONARIES["es"] ?? {}).sort());
    }
  });
});

describe("the verified result, as the form shows it", () => {
  it("reads a nested claim whether the result keys it by path or nests it", () => {
    const flat = toOnboardingData({ "address.locality": "Barcelona" }, "2026-10-05");
    const nested = toOnboardingData({ address: { locality: "Barcelona" } }, "2026-10-05");
    for (const d of [flat, nested])
      expect(d.fields).toEqual([{ path: "address.locality", value: "Barcelona" }]);
  });

  it("drops anything the policy did not ask for", () => {
    const d = toOnboardingData({ given_name: "Laura", email: "x@example.test" }, "2026-10-05");
    expect(d.fields.map((f) => f.path)).toEqual(["given_name"]);
  });

  it("works out majority from the date of birth, to the day", () => {
    expect(isAdult("2008-10-05", "2026-10-05")).toBe(true);
    expect(isAdult("2008-10-06", "2026-10-05")).toBe(false);
    expect(isAdult("not-a-date", "2026-10-05")).toBe(false);
    expect(toOnboardingData({}, "2026-10-05").adult).toBe(false);
  });

  it("has a recording that fills every field of the form", () => {
    const d = toOnboardingData(RECORDED_CLAIMS, "2026-10-05");
    expect(d.fields).toHaveLength(FIELDS.length);
    expect(d.adult).toBe(true);
  });
});

describe("the outcome of a cross-device presentation", () => {
  it("is released only for the token the asking browser was given", () => {
    const polls = new CrossDevicePolls();
    const token = polls.remember("p-1");
    expect(polls.allows("p-1", token)).toBe(true);
    expect(polls.allows("p-1", undefined)).toBe(false);
    expect(polls.allows("p-1", "")).toBe(false);
    expect(polls.allows("p-1", polls.remember("p-2"))).toBe(false);
  });

  it("leaves a same-device presentation, which it never recorded, to its id", () => {
    expect(new CrossDevicePolls().allows("p-9", undefined)).toBe(true);
  });

  it("is bounded", () => {
    const polls = new CrossDevicePolls(2);
    polls.remember("a");
    polls.remember("b");
    polls.remember("c");
    expect(polls.allows("c", undefined)).toBe(false);
    expect(polls.allows("a", undefined)).toBe(true);
  });
});

describe("the fictitious loan", () => {
  const { annualRatePercent: rate, maxPaymentShare: share, stepAmount: step } = LOAN_TERMS;

  it("computes the constant payment of an amortising loan", () => {
    expect(monthlyPayment(10_000, 48, 6.95)).toBe(239.23);
    expect(monthlyPayment(12_000, 12, 0)).toBe(1_000);
  });

  it("never offers more than was asked, nor a payment above the share of income", () => {
    expect(affordableAmount(10_000, 2_400, 48, rate, share, step)).toBe(10_000);
    const lower = affordableAmount(30_000, 1_200, 48, rate, share, step);
    expect(lower).toBeLessThan(30_000);
    expect(lower % step).toBe(0);
    expect(monthlyPayment(lower, 48, rate)).toBeLessThanOrEqual(1_200 * share);
    expect(monthlyPayment(lower + step, 48, rate)).toBeGreaterThan(1_200 * share);
    expect(affordableAmount(10_000, 0, 48, rate, share, step)).toBe(0);
  });

  it("is the arithmetic the page runs, and says the decision is simulated", () => {
    expect(CLIENT_JS).toContain("LOAN.monthly = ");
    expect(CLIENT_JS).toContain("LOAN.affordable = ");
    expect(DICTIONARIES["es"]?.loanDecisionNote).toMatch(/simulada/);
    expect(DICTIONARIES["es"]?.loanFictitious).toMatch(/ficticios/);
  });
});
