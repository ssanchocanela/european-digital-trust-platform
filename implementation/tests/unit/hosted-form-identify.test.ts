import { HostedFormReturns } from "@edtp/platform-api/modules/issuances/hosted-form-returns.js";
import { describe, expect, it } from "vitest";
import {
  BRANDS,
  type Brand,
  renderIdentify,
  renderOpenWallet,
  renderRequest,
} from "../../apps/pid-form/src/page.js";

/**
 * The representation flow of the hosted form: identify with a PID, come back, request.
 *
 * The return is the part with a security edge. The wallet's same-device return lands on the
 * platform, which must send the browser on into the form — and only there. The destination is set by
 * the platform when it starts the presentation, so a visitor cannot choose it.
 */

const corpme = BRANDS["corpme"] as Brand;

describe("the return into the form", () => {
  it("is found by presentation id, and only while the presentation lives", () => {
    let now = new Date("2026-09-24T10:00:00Z");
    const returns = new HostedFormReturns(() => now);
    returns.remember(
      "p-1",
      "https://form.example.test/continuar?presentation=p-1",
      new Date("2026-09-24T10:05:00Z"),
    );
    expect(returns.destination("p-1")).toBe(
      "https://form.example.test/continuar?presentation=p-1",
    );
    expect(returns.destination("p-2")).toBeUndefined();
    now = new Date("2026-09-24T10:05:00Z");
    expect(returns.destination("p-1")).toBeUndefined();
  });
});

describe("the pages", () => {
  it("carry the demonstration band on every step", () => {
    const pages = [
      renderIdentify({ brand: corpme, state: {}, credentialName: "Poder de representación" }),
      renderOpenWallet({ brand: corpme, walletUri: "openid4vp://?request_uri=x" }),
      renderRequest({ brand: corpme, state: {}, credentialName: "x", person: {}, fixed: [] }),
    ];
    for (const page of pages) expect(page).toContain("Entorno de demostración");
  });

  it("escapes what the wallet and the PID supply", () => {
    const html = renderRequest({
      brand: corpme,
      state: { presentation: '"><script>' },
      credentialName: "<b>x</b>",
      person: { given_name: "<img src=x onerror=alert(1)>" },
      fixed: [],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>x</b>");
  });

  it("shows the PID claims whether the result carries them flat or nested", () => {
    const flat = renderRequest({
      brand: corpme,
      state: {},
      credentialName: "x",
      person: { "place_of_birth.country": "ES" },
      fixed: [],
    });
    const nested = renderRequest({
      brand: corpme,
      state: {},
      credentialName: "x",
      person: { place_of_birth: { country: "ES" } },
      fixed: [],
    });
    for (const html of [flat, nested]) expect(html).toContain("País de nacimiento");
  });
});
