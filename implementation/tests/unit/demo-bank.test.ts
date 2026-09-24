import { describe, expect, it } from "vitest";
import {
  renderFailure,
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
