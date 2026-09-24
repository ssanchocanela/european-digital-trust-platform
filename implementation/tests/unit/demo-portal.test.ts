import { describe, expect, it } from "vitest";
import { renderAgeHome, renderAgeResult } from "../../apps/demo-bank/src/page.js";
import {
  renderForbidden,
  renderHome,
  renderOperator,
} from "../../apps/demo-portal/src/page.js";

/**
 * The demonstration portal and Tienda Demo (ADR 0010). Public pages name no real organisation, carry
 * the demonstration band, and the age check shows the result and never a date of birth.
 */
describe("demonstration portal", () => {
  const home = renderHome([
    {
      key: "banco",
      title: "Banco Demo",
      summary: "x",
      steps: ["<script>alert(1)</script>"],
      url: "https://edtp-banco.murcata.es/",
      qrSvg: "<svg></svg>",
      health: "up",
    },
    { key: "pid", title: "PID", summary: "y", steps: [], health: "down" },
  ]);

  it("carries the band, names no real organisation and escapes its content", () => {
    expect(home).toContain("Entorno de demostración");
    expect(home).not.toMatch(/FNMT|CORPME|Registradores/);
    expect(home).not.toContain("<script>alert");
  });

  it("shows each demonstration's status, and a QR only where there is a page to open", () => {
    expect(home).toContain("Disponible");
    expect(home).toContain("No disponible ahora");
    expect(home.match(/<svg>/g)?.length).toBe(1);
  });

  it("names the operator only on the operator page, and refuses without Access", () => {
    const op = renderOperator({
      who: "op@example.test",
      profile: "genérico",
      clientProfileOn: false,
      links: [],
    });
    expect(op).toContain("op@example.test");
    expect(renderForbidden()).toContain("Acceso restringido");
  });
});

describe("Tienda Demo age check", () => {
  it("is a fictional shop, not the bank", () => {
    const html = renderAgeHome();
    expect(html).toContain("Tienda Demo no es una tienda real");
    expect(html).not.toContain("Banco Demo no es un banco real");
  });

  it("shows only 'over 18', never a date of birth", () => {
    const yes = renderAgeResult(true);
    expect(yes).toContain("Mayor de 18 años");
    expect(yes).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(renderAgeResult(false)).toContain("No se ha acreditado la mayoría de edad");
  });
});
