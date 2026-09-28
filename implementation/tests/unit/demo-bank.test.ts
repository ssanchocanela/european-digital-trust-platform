import { describe, expect, it } from "vitest";
import {
  largeFamilyDiscount,
  renderFailure,
  renderFibreHome,
  renderFibreResult,
  renderHome,
  renderOpenWallet,
  renderSuccess,
} from "../../apps/demo-bank/src/page.js";

/**
 * The demonstration bank's pages. A fictional bank, so the band must be on every page; and it shows
 * values a wallet presented, so everything must be escaped.
 */
describe("demonstration bank pages", () => {
  const pages = [
    renderHome([{ key: "por", name: "Poder de representación", description: "x" }]),
    renderOpenWallet("openid4vp://?request_uri=x", "Poder notarial"),
    renderSuccess("Poder de representación", {}),
    renderFailure("Credencial no válida", "x"),
  ];

  it("carry the demonstration band, and never claim to be a real bank", () => {
    for (const page of pages) {
      expect(page).toContain("Entorno de demostración");
      expect(page).toContain("no es un banco real");
    }
  });

  it("escape what the wallet presented", () => {
    const html = renderSuccess("x", {
      "LegalEntity.LegalName": "<script>alert(1)</script>",
      ProxyPowerScope: [{ Constraints: [{ Description: "<img src=x onerror=alert(1)>" }] }],
    });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
  });

  it("names the claims a representative is shown, and decodes the code lists", () => {
    const html = renderSuccess("Poder de representación", {
      "LegalEntity.LegalName": "Fictitious Test Company S.L. (TEST ONLY)",
      "Proxy.EntityType": 1,
    });
    expect(html).toContain("Empresa");
    expect(html).toContain("Persona física");
    expect(html).toContain("Operación autorizada");
  });
});

/**
 * Fibra Demo: a fictitious fibre operator that gives a large family a discount. It asks for the title's
 * category and expiry date only, and applies its own rule on the title's expiry.
 */
describe("Fibra Demo, the large-family discount", () => {
  const today = "2026-09-28";
  const valid = { category: "general", date_of_expiry: "2031-01-15" };

  it("applies to a title in force with a known category", () => {
    expect(largeFamilyDiscount(valid, today).applies).toBe(true);
    expect(largeFamilyDiscount({ ...valid, category: "special" }, today).applies).toBe(true);
    // The last day of validity still counts.
    expect(largeFamilyDiscount({ ...valid, date_of_expiry: today }, today).applies).toBe(true);
  });

  it("does not apply to an expired title, an unknown category, or missing claims", () => {
    expect(largeFamilyDiscount({ ...valid, date_of_expiry: "2026-09-27" }, today).applies).toBe(
      false,
    );
    expect(largeFamilyDiscount({ ...valid, category: "gold" }, today).applies).toBe(false);
    expect(largeFamilyDiscount({ category: "general" }, today).applies).toBe(false);
    expect(largeFamilyDiscount({ ...valid, date_of_expiry: "15/01/2031" }, today).applies).toBe(
      false,
    );
  });

  it("carries the band on every page, and never claims to be a real operator", () => {
    for (const page of [
      renderFibreHome(),
      renderFibreResult(valid, today),
      renderFibreResult({ ...valid, date_of_expiry: "2020-01-01" }, today),
    ]) {
      expect(page).toContain("Entorno de demostración");
      expect(page).toContain("no es una operadora real");
    }
  });

  it("shows the discounted price and only what it received", () => {
    const html = renderFibreResult(valid, today);
    expect(html).toContain("28,00 EUR/mes");
    expect(html).toContain("<strong>General</strong>");
    expect(html).toContain("2031-01-15");
  });
});
