/**
 * The demonstration bank, rendered on the server. No script: every page is a form, a link or a
 * refresh.
 *
 * A **fictional** bank — "Banco Demo" — in a generic retail-banking look, and never any real bank's
 * name, logo or colours. Every page carries the demonstration band, so no page can be taken for a
 * real bank asking for real data. The operation it "authorises" is fictitious and moves nothing.
 */

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );

export interface CredentialChoice {
  readonly key: string;
  readonly name: string;
  readonly description: string;
}

/** The fictitious operation the representative is asked to authorise. */
export const OPERATION = {
  title: "Transferencia en nombre de la empresa",
  amount: "2.500,00 EUR",
  beneficiary: "Proveedor Ficticio S.L.",
  concept: "Factura de prueba 2026-0001",
} as const;

/** Readable names for the claims a Power of X result carries; anything else is shown by its path. */
const LABELS: Readonly<Record<string, string>> = {
  "LegalEntity.Euid": "EUID de la empresa",
  "LegalEntity.LegalName": "Empresa",
  "NaturalEntityProxy.GivenName": "Nombre del representante",
  "NaturalEntityProxy.FamilyName": "Apellidos del representante",
  "Proxy.EntityType": "Tipo de representante",
  "ProxyPosition.Position": "Cargo",
  "ProxyEmployeeAuthorisation.Faculty": "Facultad",
  "ProxyEmployeeAuthorisation.Limitation": "Limitación",
  ProxyPowerScope: "Poderes",
  Type: "Tipo",
  Faculty: "Facultad",
  Limitation: "Limitación",
  Constraints: "Condiciones",
  Description: "Descripción",
  Mandator: "Poderdante",
  GivenName: "Nombre",
  FamilyName: "Apellidos",
  BirthDate: "Fecha de nacimiento",
  BirthPlace: "Lugar de nacimiento",
  Nationality: "Nacionalidad",
  EvidenceURI: "Evidencia",
  ServiceAccess: "Servicios",
  RelyingPartyName: "Servicio",
  RelyingPartyID: "Identificador del servicio",
  RelyingPartyServices: "Operaciones",
};

const CODES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "Proxy.EntityType": { "0": "Persona jurídica", "1": "Persona física" },
  Type: { "0": "Orgánica", "1": "Voluntaria", "2": "Apud acta" },
  Limitation: { true: "Con límites", false: "Sin límites" },
  "ProxyEmployeeAuthorisation.Limitation": { true: "Con límites", false: "Sin límites" },
};

const label = (key: string): string => LABELS[key] ?? key;

const value = (key: string, v: unknown): string => {
  const code = CODES[key]?.[String(v)];
  if (code) return `<strong>${escapeHtml(code)}</strong>`;
  if (Array.isArray(v) && v.some((x) => typeof x === "object" && x !== null)) {
    return v
      .map(
        (item, i) =>
          `<div class="group"><div class="group-title">${i + 1}</div>${rows(item as Record<string, unknown>)}</div>`,
      )
      .join("");
  }
  if (Array.isArray(v)) return `<strong>${escapeHtml(v.map(String).join(", "))}</strong>`;
  if (typeof v === "object" && v !== null) return rows(v as Record<string, unknown>);
  return `<strong>${escapeHtml(String(v))}</strong>`;
};

const rows = (claims: Readonly<Record<string, unknown>>): string =>
  Object.entries(claims)
    .map(([k, v]) => `<div class="kv"><span>${escapeHtml(label(k))}</span>${value(k, v)}</div>`)
    .join("");

const operationBox = (): string => `
  <div class="op">
    <div class="op-title">${escapeHtml(OPERATION.title)}</div>
    <div class="kv"><span>Importe</span><strong>${escapeHtml(OPERATION.amount)}</strong></div>
    <div class="kv"><span>Beneficiario</span><strong>${escapeHtml(OPERATION.beneficiary)}</strong></div>
    <div class="kv"><span>Concepto</span><strong>${escapeHtml(OPERATION.concept)}</strong></div>
  </div>`;

export const renderHome = (choices: readonly CredentialChoice[]): string =>
  shell(
    "Autorizar operación",
    `
    <nav class="crumbs">Banca Empresas › Operaciones pendientes › <strong>Autorizar</strong></nav>
    <h1>Autorizar una operación de empresa</h1>
    <p class="lead">Para firmar en nombre de la empresa, acredite su representación presentando una credencial desde su cartera digital.</p>
    ${operationBox()}
    <h2>¿Con qué credencial quiere acreditarse?</h2>
    <div class="choices">
      ${choices
        .map(
          (c) => `
      <form method="post" action="verificar" class="choice">
        <input type="hidden" name="tipo" value="${escapeHtml(c.key)}">
        <div class="choice-name">${escapeHtml(c.name)}</div>
        <p>${escapeHtml(c.description)}</p>
        <button type="submit">Presentar con mi cartera</button>
      </form>`,
        )
        .join("")}
    </div>`,
  );

export const renderOpenWallet = (
  walletUri: string,
  credentialName: string,
  site: Site = "bank",
): string =>
  shell(
    "Abrir la cartera",
    `
    <h1>Presente su ${escapeHtml(credentialName.toLowerCase())}</h1>
    <div class="card">
      <p>Pulse el botón para abrir su cartera. Revise qué datos se le piden y compártalos. Al terminar, la cartera le devolverá aquí.</p>
      <div class="actions"><a class="button" href="${escapeHtml(walletUri)}">Abrir mi cartera</a></div>
    </div>`,
    "",
    site,
  );

export const renderWaiting = (site: Site = "bank"): string =>
  shell(
    "Comprobando",
    `
    <h1>Comprobando su credencial…</h1>
    <div class="card"><p>Estamos verificando la credencial que ha presentado. Esta página se actualiza sola.</p></div>`,
    '<meta http-equiv="refresh" content="3">',
    site,
  );

export const renderSuccess = (
  credentialName: string,
  claims: Readonly<Record<string, unknown>>,
): string =>
  shell(
    "Operación autorizada",
    `
    <div class="ok" role="status"><span class="tick" aria-hidden="true">✓</span> Credencial verificada. Operación autorizada.</div>
    <h1>Representación acreditada</h1>
    <p class="lead">Su <strong>${escapeHtml(credentialName)}</strong> es válida: la firma del emisor, su vigencia y su estado se han comprobado. La operación queda autorizada en nombre de la empresa.</p>
    ${operationBox()}
    <div class="card">
      <h2>Datos acreditados</h2>
      <div class="kvs">${rows(claims)}</div>
    </div>
    <div class="actions"><a class="button secondary" href="./">Autorizar otra operación</a></div>`,
  );

export const renderFailure = (title: string, body: string, site: Site = "bank"): string =>
  shell(
    title,
    `
    <div class="ko" role="alert"><span aria-hidden="true">✕</span> ${escapeHtml(title)}</div>
    <div class="card"><p>${escapeHtml(body)}</p></div>
    <div class="actions"><a class="button secondary" href="${site === "shop" ? "edad" : "./"}">Volver a intentarlo</a></div>`,
    "",
    site,
  );

/** The two fictional sites this process serves. Neither is a real business. */
type Site = "bank" | "shop";
const SITES = {
  bank: {
    name: "Banco Demo",
    sub: "Banca Empresas",
    mark: "B",
    band: "Banco Demo no es un banco real y esta operación es ficticia.",
    brand: "#0b3d5c",
    brandDark: "#072a40",
    accent: "#1b8a7a",
  },
  shop: {
    name: "Tienda Demo",
    sub: "Productos para mayores de 18",
    mark: "T",
    band: "Tienda Demo no es una tienda real y no vende nada.",
    brand: "#5b2a86",
    brandDark: "#3f1d5d",
    accent: "#d98e04",
  },
} as const;

const shell = (title: string, main: string, head = "", site: Site = "bank"): string => {
  const s = SITES[site];
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${head}
<title>${escapeHtml(title)} — ${s.name} (demostración)</title>
<style>
  :root { --brand:${s.brand}; --brand-dark:${s.brandDark}; --accent:${s.accent}; --line:#dfe4ea; --muted:#5b6770; --bg:#f3f5f8; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system, "Segoe UI", Roboto, Arial, sans-serif; color:#1c2328; background:var(--bg); }
  .demo { background:#fff4ce; color:#5c4400; border-bottom:1px solid #f0d77a; font-size:14px; padding:8px 16px; text-align:center; }
  header { background:var(--brand); color:#fff; }
  .bar { max-width:880px; margin:0 auto; padding:14px 16px; display:flex; align-items:center; gap:12px; }
  .mark { width:34px; height:34px; border-radius:8px; background:var(--accent); display:grid; place-items:center; font-weight:800; font-size:18px; }
  .brand { font-weight:700; font-size:19px; letter-spacing:.2px; }
  .brand small { display:block; font-weight:400; font-size:12px; opacity:.8; }
  main { max-width:880px; margin:0 auto; padding:24px 16px 48px; }
  .crumbs { color:var(--muted); font-size:13px; margin-bottom:12px; }
  h1 { font-size:24px; margin:0 0 10px; color:var(--brand); }
  h2 { font-size:17px; margin:26px 0 12px; }
  .lead { color:var(--muted); margin:0 0 20px; }
  .card, .op { background:#fff; border:1px solid var(--line); border-radius:8px; padding:20px; margin-bottom:16px; }
  .op { border-left:4px solid var(--accent); }
  .op-title { font-weight:700; margin-bottom:10px; }
  .kv { display:flex; justify-content:space-between; gap:16px; padding:8px 0; border-bottom:1px solid var(--line); font-size:15px; }
  .kv:last-child { border-bottom:0; }
  .kv > span { color:var(--muted); }
  .kv strong { text-align:right; word-break:break-word; }
  .group { border:1px solid var(--line); border-radius:6px; padding:8px 12px; margin:6px 0; flex:1; }
  .group-title { font-size:12px; color:var(--muted); }
  .choices { display:grid; gap:14px; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); }
  .choice { background:#fff; border:1px solid var(--line); border-radius:8px; padding:18px; display:flex; flex-direction:column; }
  .choice-name { font-weight:700; color:var(--brand); margin-bottom:6px; }
  .choice p { color:var(--muted); font-size:14px; flex:1; margin:0 0 14px; }
  .actions { margin-top:20px; }
  button, .button { display:inline-block; background:var(--brand); color:#fff; border:0; border-radius:6px; padding:12px 22px; font-size:15px; font-weight:600; cursor:pointer; text-decoration:none; text-align:center; }
  button:hover, .button:hover { background:var(--brand-dark); }
  .button.secondary { background:#fff; color:var(--brand); border:1px solid var(--brand); }
  .ok, .ko { border-radius:8px; padding:14px 16px; font-weight:700; margin-bottom:18px; }
  .ok { background:#e5f5f1; color:#0d5c50; border:1px solid #a9dccf; }
  .ko { background:#fdecec; color:#8a1c1c; border:1px solid #f1b7b7; }
  .tick { display:inline-block; margin-right:6px; }
  footer { color:var(--muted); font-size:12px; text-align:center; padding:20px 16px 32px; }
</style>
</head>
<body>
  <div class="demo" role="note"><strong>Entorno de demostración.</strong> ${s.band} Use únicamente credenciales de prueba.</div>
  <header><div class="bar"><div class="mark" aria-hidden="true">${s.mark}</div><div class="brand">${s.name}<small>${s.sub}</small></div></div></header>
  <main>${main}</main>
  <footer>Demostración de la European Digital Trust Platform. Ningún dato se guarda en esta página.</footer>
</body>
</html>`;
};

// --- Tienda Demo: the age check ----------------------------------------------------------------

export const renderAgeHome = (): string =>
  shell(
    "Comprobación de edad",
    `
    <nav class="crumbs">Tienda Demo › Cesta › <strong>Comprobación de edad</strong></nav>
    <h1>Confirme que es mayor de edad</h1>
    <p class="lead">Su cesta incluye un producto para mayores de 18 años. Acredítelo con su cartera digital: la tienda recibe solo la respuesta «mayor de edad», <strong>nunca su fecha de nacimiento</strong>.</p>
    <div class="op">
      <div class="op-title">Su cesta</div>
      <div class="kv"><span>Producto de ejemplo (+18)</span><strong>19,90 EUR</strong></div>
    </div>
    <form method="post" action="verificar" class="card">
      <input type="hidden" name="tipo" value="edad">
      <p>Se abrirá su cartera y le pedirá su fecha de nacimiento, del PID. La cartera la comparte con la plataforma de verificación, que solo devuelve a la tienda si es mayor de edad.</p>
      <div class="actions"><button type="submit">Comprobar mi edad con la cartera</button></div>
    </form>`,
    "",
    "shop",
  );

export const renderAgeResult = (overEighteen: boolean): string =>
  overEighteen
    ? shell(
        "Edad comprobada",
        `
    <div class="ok" role="status"><span class="tick" aria-hidden="true">✓</span> Mayor de edad. Puede continuar con la compra.</div>
    <h1>Edad comprobada</h1>
    <div class="card">
      <h2>Lo que ha recibido la tienda</h2>
      <div class="kvs"><div class="kv"><span>Mayor de 18 años</span><strong>Sí</strong></div></div>
      <p class="lead" style="margin-top:14px">Nada más: ni su fecha de nacimiento, ni su nombre, ni ningún otro dato de su PID.</p>
    </div>
    <div class="actions"><a class="button secondary" href="edad">Volver a comprobar</a></div>`,
        "",
        "shop",
      )
    : renderFailure(
        "No se ha acreditado la mayoría de edad",
        "La credencial es válida, pero no acredita que sea mayor de 18 años.",
        "shop",
      );
