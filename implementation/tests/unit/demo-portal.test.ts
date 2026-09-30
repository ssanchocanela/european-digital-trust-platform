import { describe, expect, it } from "vitest";
import { renderAgeHome, renderAgeResult } from "../../apps/demo-bank/src/page.js";
import { ageVerificationCards } from "../../apps/demo-portal/src/age-verification.js";
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
    // Cloudflare's Email Obfuscation would otherwise replace it with "[email protected]", decoded by a
    // script the page's CSP rightly blocks.
    expect(op).toContain("<!--email_off-->op@example.test<!--/email_off-->");
    expect(renderForbidden()).toContain("Acceso restringido");
  });
});

describe("operator view: scheduled negative checks", () => {
  const view = (result: string) =>
    renderOperator({
      who: "op@example.test",
      checks: { at: "2026-09-24T18:00:00Z", result, summary: "<b>x</b>" },
      profile: "genérico",
      clientProfileOn: false,
      links: [],
    });

  it("says plainly when the checks failed and the tunnel was stopped", () => {
    expect(view("pass")).toContain("Correctas");
    expect(view("exposed")).toContain("FALLIDAS: túnel detenido");
    expect(view("unreachable")).toContain("No se pudieron completar");
    expect(view("pass")).not.toContain("<b>x</b>");
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

describe("the age verification demos' cards (ADR 0011)", () => {
  const cards = ageVerificationCards(
    { url: "https://av-lumen.murcata.es/", qrSvg: "<svg>l</svg>", health: "up" },
    { url: "https://av-plaza.murcata.es/", qrSvg: "<svg>p</svg>", health: "down" },
  );
  const home = renderHome(cards);

  it("point at the two public hostnames, each with its own status", () => {
    expect(cards.map((card) => card.url)).toEqual([
      "https://av-lumen.murcata.es/",
      "https://av-plaza.murcata.es/",
    ]);
    expect(cards.map((card) => card.health)).toEqual(["up", "down"]);
    expect(home).toContain("Lumen");
    expect(home).toContain("Plaza");
  });

  it("send the visitor to the age verification app, not the EDTP wallet", () => {
    for (const card of cards) {
      expect(card.steps.join(" ")).toContain("app de verificación de edad");
      expect(card.steps.join(" ")).not.toMatch(/cartera EDTP/);
    }
  });

  it("never promise a date of birth to the site", () => {
    expect(home).toMatch(/sin nombre ni fecha de nacimiento|no pide la fecha de nacimiento/);
  });
});
