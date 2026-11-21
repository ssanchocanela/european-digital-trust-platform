import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CaseBook } from "../../apps/demo-onboarding/src/backoffice.js";
import { brandCss, brandDictionary, loadBrand } from "../../apps/demo-onboarding/src/brand.js";
import {
  FIELDS,
  INCOME_REQUESTED_CLAIMS,
  isAdult,
  LOGIN_REQUESTED_CLAIMS,
  loginDocument,
  REQUESTED_CLAIMS,
  toIncomeData,
  toOnboardingData,
} from "../../apps/demo-onboarding/src/claims.js";
import { CLIENT_JS } from "../../apps/demo-onboarding/src/client.js";
import { CustomerBook, normaliseDocument } from "../../apps/demo-onboarding/src/customers.js";
import { DICTIONARIES, dictionary } from "../../apps/demo-onboarding/src/i18n.js";
import {
  affordableAmount,
  LOAN_TERMS,
  monthlyPayment,
} from "../../apps/demo-onboarding/src/loan.js";
import {
  CONTENT_SECURITY_POLICY,
  renderBackoffice,
  renderPlain,
  renderShell,
} from "../../apps/demo-onboarding/src/page.js";
import { CrossDevicePolls } from "../../apps/demo-onboarding/src/polls.js";
import {
  RECORDED_CLAIMS,
  RECORDED_INCOME_CLAIMS,
} from "../../apps/demo-onboarding/src/recorded.js";

/**
 * Banco Horizonte, the bank onboarding demonstration. A fictitious bank, so the band is on every
 * page; it shows values a wallet presented, so nothing is parsed as markup; and what it asks a PID
 * for is exactly what its policy registers.
 */
const { t } = dictionary("es");
const shell = (extra: { resume?: string; recorded?: unknown; login?: boolean } = {}) =>
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

describe("the income certificate the loan asks for", () => {
  const definition = JSON.parse(
    readFileSync(resolve(__dirname, "../../scripts/income/income-certificate.json"), "utf8"),
  ) as {
    type: { claims: { path: string[] }[]; fixedClaims: Record<string, unknown> };
    fromPid: Record<string, string>;
    presentation: { requestedClaims: string[][] };
    payloadSchema: { required: string[] };
  };
  const claims = definition.type.claims.map((c) => c.path.join("."));

  it("is asked for exactly what its policy requests", () => {
    expect(INCOME_REQUESTED_CLAIMS).toEqual(definition.presentation.requestedClaims);
  });

  it("requests only claims the certificate carries, and never the employer", () => {
    for (const path of definition.presentation.requestedClaims)
      expect(claims).toContain(path.join("."));
    expect(JSON.stringify(INCOME_REQUESTED_CLAIMS)).not.toContain("employer");
  });

  it("has a value for every claim: from the PID, or fixed", () => {
    const supplied = [
      ...Object.keys(definition.fromPid),
      ...Object.keys(definition.type.fixedClaims),
    ];
    expect([...supplied].sort()).toEqual([...claims].sort());
    expect(definition.payloadSchema.required.filter((r) => r !== "vct").sort()).toEqual(
      [...claims].sort(),
    );
  });

  it("is read as figures, and refused when one is missing", () => {
    expect(toIncomeData(RECORDED_INCOME_CLAIMS)).toEqual({
      netMonthlyIncome: 2450,
      contractType: "permanent",
      employedSince: "2019-03-01",
      holder: { givenName: "Laura", familyName: "Martínez Soler", birthdate: "1992-03-14" },
    });
    expect(
      toIncomeData({ ...RECORDED_INCOME_CLAIMS, net_monthly_income: "2450" }),
    ).toBeUndefined();
    expect(toIncomeData({ contract_type: "permanent" })).toBeUndefined();
  });

  it("belongs, in the recording, to the person the recorded PID names", () => {
    const income = toIncomeData(RECORDED_INCOME_CLAIMS);
    expect(income?.holder.givenName).toBe(RECORDED_CLAIMS["given_name"]);
    expect(income?.holder.birthdate).toBe(RECORDED_CLAIMS["birthdate"]);
  });
});

describe("the back office's case book", () => {
  const identity = toOnboardingData(RECORDED_CLAIMS, "2026-10-05");
  const income = toIncomeData(RECORDED_INCOME_CLAIMS);

  it("opens a case on a verified PID, once, and adds what follows to it", () => {
    const book = new CaseBook();
    book.identity("11111111-aaaa", identity);
    book.identity("11111111-aaaa", { fields: [], adult: false });
    expect(book.list()).toHaveLength(1);
    expect(book.list()[0]?.identity.adult).toBe(true);
    book.link("99999999-cccc", "11111111-aaaa");
    expect(income && book.income("99999999-cccc", income)).toBe(true);
    expect(
      book.declare("11111111-aaaa", { product: "prestamo", signed: true, granted: 10_000 }),
    ).toBe(true);
    expect(book.list()[0]).toMatchObject({
      reference: "11111111",
      income: { netMonthlyIncome: 2450 },
      declared: { product: "prestamo", signed: true },
    });
  });

  it("takes nothing for a case no verified PID opened", () => {
    const book = new CaseBook();
    expect(book.declare("nobody", { product: "cuenta", signed: true })).toBe(false);
    expect(income && book.income("nobody", income)).toBe(false);
    book.link("income-1", "nobody");
    expect(income && book.income("income-1", income)).toBe(false);
    expect(book.list()).toHaveLength(0);
  });

  it("knows from the start what an application is for, and which documents it is to bring", () => {
    const book = new CaseBook();
    book.expect("loan-pid", "prestamo", true);
    book.expect("account-pid", "cuenta", false);
    book.identity("loan-pid", identity);
    book.identity("account-pid", identity);
    const page = (reference: string) =>
      renderBackoffice({
        t,
        assets: "assets/abc",
        who: "operator@example.test",
        cases: book.list().filter((c) => c.reference === reference),
        now: new Date(),
      });
    expect(page("loan-pid")).toContain(t.boProductLoan);
    expect(page("loan-pid")).toContain(t.boDocIncome);
    expect(page("loan-pid")).toContain(t.boPending);
    expect(page("account-")).toContain(t.boProductAccount);
    expect(page("account-")).not.toContain(t.boDocIncome);

    book.link("loan-income", "loan-pid");
    if (income) book.income("loan-income", income);
    expect(page("loan-pid")).not.toContain(t.boPending);
    expect(page("loan-pid")).toContain(t.boDocIncome);
  });

  it("forgets a case after its time, and holds only so many", () => {
    let now = new Date("2026-10-05T10:00:00Z");
    const book = new CaseBook(2, 30 * 60_000, () => now);
    book.identity("a", identity);
    book.identity("b", identity);
    book.identity("c", identity);
    expect(book.list().map((c) => c.reference)).toEqual(["c", "b"]);
    now = new Date("2026-10-05T10:30:00Z");
    expect(book.list()).toHaveLength(0);
  });

  it("is shown with the band, who is looking, and nothing parsed as markup", () => {
    const book = new CaseBook();
    book.identity("22222222-bbbb", {
      fields: [{ path: "given_name", value: "<script>alert(1)</script>" }],
      adult: true,
    });
    const page = renderBackoffice({
      t,
      assets: "assets/abc",
      who: "operator@example.test",
      cases: book.list(),
      now: new Date(),
    });
    expect(page).toContain("Entorno de demostración");
    expect(page).toContain("operator@example.test");
    expect(page).not.toContain("<script>alert(1)");
    expect(page).not.toMatch(/<script/);
  });
});

describe("the login with the wallet", () => {
  const definition = JSON.parse(
    readFileSync(resolve(__dirname, "../../scripts/onboarding/bank-login.json"), "utf8"),
  ) as { policy: { requestedClaims: string[][] } };

  it("asks the PID for the document number and nothing else, as its policy requests", () => {
    expect(LOGIN_REQUESTED_CLAIMS).toEqual(definition.policy.requestedClaims);
    expect(LOGIN_REQUESTED_CLAIMS).toEqual([["personal_administrative_number"]]);
  });

  it("reads the document number, and finds none in a PID without it", () => {
    expect(loginDocument({ personal_administrative_number: "12345678Z" })).toBe("12345678Z");
    expect(loginDocument({ personal_administrative_number: "  " })).toBeUndefined();
    expect(loginDocument({ given_name: "Elena" })).toBeUndefined();
  });

  it("treats one document written two ways as one", () => {
    expect(normaliseDocument("12.345.678-z")).toBe(normaliseDocument("12345678Z"));
  });

  it("makes a customer only when the contract of a verified PID is signed", () => {
    const book = new CustomerBook();
    expect(book.enrol("never-verified")).toBeUndefined();
    book.expect("p1", "12345678Z", "Elena");
    expect(book.find("12345678Z")).toBeUndefined();
    expect(book.isCustomer("12345678Z")).toBe(false);
    const customer = book.enrol("p1");
    expect(customer?.givenName).toBe("Elena");
    expect(customer?.iban).toMatch(/^ES00 0000 0000 0000 0000 \d{4}$/);
    expect(book.find("12345678-z")).toEqual(customer);
    expect(book.isCustomer("12345678Z")).toBe(true);
    expect(book.find("87654321X")).toBeUndefined();
    expect(book.enrol("p1")).toBeUndefined();
  });

  it("keeps a digest of the document, never the document", () => {
    const book = new CustomerBook();
    book.expect("p1", "12345678Z", "Elena");
    book.enrol("p1");
    const held = JSON.stringify([
      ...(book as unknown as { customers: Map<string, unknown> }).customers,
    ]);
    expect(held).not.toContain("12345678");
    expect(held).toMatch(/[0-9a-f]{64}/);
  });

  it("forgets an account opening that is never signed", () => {
    let now = 0;
    const book = new CustomerBook(() => now);
    book.expect("p1", "12345678Z", "Elena");
    now += 61 * 60 * 1000;
    expect(book.enrol("p1")).toBeUndefined();
  });

  it("recognises nothing across a restart: the key is new each time", () => {
    const first = new CustomerBook();
    first.expect("p1", "12345678Z", "Elena");
    first.enrol("p1");
    expect(new CustomerBook().find("12345678Z")).toBeUndefined();
  });

  it("offers no field to type a user name or a password into", () => {
    expect(shell({ login: true })).not.toMatch(/type=["']?password|contraseña<\/label/i);
    expect(CLIENT_JS).not.toMatch(/type = "password"|\.type = 'password'/);
  });
});

describe("a client's brand", () => {
  const dir = (
    brand: Record<string, unknown>,
    logo = "<svg xmlns='http://www.w3.org/2000/svg'/>",
  ) => {
    const d = mkdtempSync(join(tmpdir(), "brand-"));
    writeFileSync(join(d, "brand.json"), JSON.stringify(brand));
    writeFileSync(join(d, "logo.svg"), logo);
    return d;
  };
  const good = {
    name: "Banco Cliente",
    band: "Demostración preparada para Banco Cliente. No es un servicio de Banco Cliente.",
    legal:
      "Página de demostración de la European Digital Trust Platform, con permiso del cliente.",
    shapeA: "#FFC600",
    shapeB: "#007EAE",
    logo: "logo.svg",
  };

  it("is read from a directory on the host, never from the code", () => {
    const brand = loadBrand(dir(good));
    expect(brand.name).toBe("Banco Cliente");
    expect(brand.logo.type).toBe("image/svg+xml");
    expect(brandCss(brand)).toContain("--shape-a:#FFC600");
  });

  it("is refused unless its band and legal line say it is a demonstration", () => {
    expect(() =>
      loadBrand(dir({ ...good, band: "Bienvenido a Banco Cliente, tu banco de siempre." })),
    ).toThrow(/demonstration/);
    expect(() =>
      loadBrand(dir({ ...good, legal: "Banco Cliente S.A., todos los derechos reservados." })),
    ).toThrow(/demonstration/);
  });

  it("refuses anything but a plain colour and an SVG or PNG logo", () => {
    expect(() => loadBrand(dir({ ...good, shapeA: "red;}body{x" }))).toThrow();
    expect(() => loadBrand(dir({ ...good, logo: "../secret.svg" }))).toThrow();
    expect(() => loadBrand(dir({ ...good, logo: "logo.html" }))).toThrow();
  });

  it("renames every text, and puts its own band in place of Banco Horizonte's", () => {
    const branded = brandDictionary(t, loadBrand(dir(good)));
    expect(JSON.stringify(branded)).not.toMatch(/Horizonte/);
    expect(branded.band).toBe(good.band);
    expect(branded.a5WelcomeTitle).toContain("Banco Cliente");
  });

  it("shows its logo, its name and its band, and keeps the page's own rules", () => {
    const branded = brandDictionary(t, loadBrand(dir(good)));
    const page = renderShell({
      lang: "es",
      t: branded,
      assets: "assets/abc",
      live: true,
      recorded: {},
      brand: {
        name: "Banco Cliente",
        logo: "assets/abc/logo.svg",
        css: "assets/abc/brand.css",
      },
    });
    expect(page).toContain(
      '<img class="brand-logo" src="assets/abc/logo.svg" alt="Banco Cliente">',
    );
    expect(page).toContain("Demostración preparada para Banco Cliente");
    expect(page).not.toMatch(/Banco Horizonte/);
    expect(page).not.toMatch(/<script(?![^>]*(type="application\/json"|src=))/);
  });
});
