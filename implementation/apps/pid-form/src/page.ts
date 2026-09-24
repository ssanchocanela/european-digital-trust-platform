/**
 * The hosted forms, rendered on the server. No script: every page is a form, a link, or a refresh.
 *
 * Styled after the issuing organisation's public site, for demonstrations to those organisations —
 * FNMT for the PID, CORPME (the Spanish Registrars' association) for the representation credentials —
 * and **always** carrying the demonstration band, so no page can be taken for a real service
 * collecting real personal data. Every value typed or shown is expected to be fictitious.
 */

export interface FormField {
  readonly path: string;
  readonly display: readonly { readonly lang: string; readonly value: string }[];
  readonly valueType: string;
  readonly mandatory: boolean;
}

export interface FixedClaim {
  readonly path: string;
  readonly display: readonly { readonly lang: string; readonly value: string }[];
  readonly value: unknown;
}

export interface Brand {
  readonly key: string;
  readonly organisation: string;
  /** An image under `assets/`, or absent for the neutral brand, which draws a text mark instead. */
  readonly logo?: string;
  readonly logoAlt: string;
  /** Whether this is a real organisation's look — shown only behind the login (ADR 0010). */
  readonly client: boolean;
  readonly colour: string;
  readonly colourDark: string;
  readonly service: string;
  readonly serviceSub: string;
  readonly crumbs: string;
}

export const BRANDS: Readonly<Record<string, Brand>> = {
  /**
   * The neutral look, and the default. Public demonstrations use it: no real organisation's name, logo
   * or colours (ADR 0010).
   */
  demo: {
    key: "demo",
    organisation: "EDTP Demo",
    logoAlt: "EDTP Demo",
    client: false,
    colour: "#2f4858",
    colourDark: "#1f3140",
    service: "Credenciales de demostración",
    serviceSub: "Emisión de credenciales",
    crumbs: "Inicio › Credenciales",
  },
  fnmt: {
    key: "fnmt",
    client: true,
    organisation: "FNMT-RCM",
    logo: "assets/fnmt-logo.png",
    logoAlt: "FNMT — Real Casa de la Moneda",
    colour: "#1a3b88",
    colourDark: "#122a63",
    service: "Cartera de Identidad Digital",
    serviceSub: "Emisión de PID",
    crumbs: "Inicio › Cartera de Identidad Digital",
  },
  corpme: {
    key: "corpme",
    client: true,
    organisation: "Colegio de Registradores (CORPME)",
    logo: "assets/corpme-logo.png",
    logoAlt: "Registradores de España",
    colour: "#c41230",
    colourDark: "#9b0e26",
    service: "Sede electrónica",
    serviceSub: "Certificados de representación",
    crumbs: "Inicio › Sede electrónica › Representación",
  },
};

/**
 * The look for one engine tenant's page. A client's brand is shown only on the one host allowed to
 * carry it, which sits behind Cloudflare Access (ADR 0010 §2). Anywhere else, and for any brand not
 * known, the neutral one. `brandedHost` unset keeps laptop sessions as they were: no host restriction.
 */
export const selectBrand = (
  configured: Readonly<Record<string, string>>,
  tenant: string,
  host: string,
  brandedHost: string | undefined,
): Brand => {
  const neutral = BRANDS["demo"] as Brand;
  const brand = BRANDS[configured[tenant] ?? "demo"] ?? neutral;
  if (!brand.client) return brand;
  return !brandedHost || host === brandedHost ? brand : neutral;
};

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

const spanish = (
  display: readonly { readonly lang: string; readonly value: string }[],
  fallback: string,
) =>
  display.find((d) => d.lang.startsWith("es"))?.value ??
  display.find((d) => d.lang.startsWith("en"))?.value ??
  fallback;

const hidden = (fields: Readonly<Record<string, string>>): string =>
  Object.entries(fields)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");

// --- the typed PID form ---------------------------------------------------------------------

/** Guidance under the few fields whose expected form is not obvious. */
const HINTS: Readonly<Record<string, string>> = {
  nationalities:
    "Código de país de dos letras (ISO 3166-1), p. ej. ES. Varios, separados por comas.",
  "place_of_birth.country": "Código de país de dos letras, p. ej. ES.",
  "address.country": "Código de país de dos letras, p. ej. ES.",
  personal_administrative_number: "DNI o NIE, sin espacios. Use un número ficticio.",
  phone_number: "Con prefijo internacional y solo cifras, p. ej. +34600000000.",
  issuing_jurisdiction: "Código ISO 3166-2, p. ej. ES-MD. Normalmente se deja vacío.",
};

/** The PID Rulebook's `sex` code list (section 2.3), shown as words. */
const SEX_OPTIONS: readonly (readonly [string, string])[] = [
  ["", "—"],
  ["0", "No consta"],
  ["1", "Hombre"],
  ["2", "Mujer"],
  ["3", "Otro"],
  ["4", "Intersexual"],
  ["5", "Diverso"],
  ["6", "Abierto"],
  ["9", "No aplicable"],
];

/**
 * Which part of the form a field belongs in. The identity comes first and is what the Rulebook makes
 * mandatory; residence and contact, and the document's own data, are optional and folded away.
 */
const SECTIONS: readonly {
  readonly title: string;
  readonly optional: boolean;
  readonly match: (p: string) => boolean;
}[] = [
  {
    title: "Domicilio y contacto",
    optional: true,
    match: (p) => p.startsWith("address.") || p === "email" || p === "phone_number",
  },
  {
    title: "Datos del documento",
    optional: true,
    match: (p) =>
      p === "document_number" ||
      p === "date_of_issuance" ||
      p === "date_of_expiry" ||
      p === "issuing_jurisdiction",
  },
];

const input = (field: FormField, value: string): string => {
  const name = `attr:${escapeHtml(field.path)}`;
  const required = field.mandatory ? " required" : "";
  const common = `id="${name}" name="${name}" value="${escapeHtml(value)}"${required}`;
  if (field.path === "sex") {
    return `<select id="${name}" name="${name}"${required}>${SEX_OPTIONS.map(
      ([v, label]) =>
        `<option value="${v}"${v === value ? " selected" : ""}>${escapeHtml(label)}</option>`,
    ).join("")}</select>`;
  }
  switch (field.valueType) {
    case "date":
      return `<input type="date" ${common}>`;
    case "number":
    case "integer":
      return `<input type="number" ${common}>`;
    default: {
      const upper = field.path.endsWith("country") || field.path === "nationalities";
      const extra = upper
        ? ` maxlength="${field.path === "nationalities" ? 30 : 2}" style="text-transform:uppercase"`
        : ` maxlength="200"`;
      return `<input type="text" autocomplete="off" ${common}${extra}>`;
    }
  }
};

export interface FormPage {
  readonly brand: Brand;
  readonly state: Readonly<Record<string, string>>;
  readonly credentialName: string;
  readonly fields: readonly FormField[];
  readonly values?: Readonly<Record<string, string>>;
  readonly errors?: readonly string[];
}

const errorBox = (errors: readonly string[] | undefined): string =>
  errors && errors.length > 0
    ? `<div class="alert" role="alert"><strong>No se ha podido emitir la credencial.</strong><ul>${errors
        .map((e) => `<li>${escapeHtml(e)}</li>`)
        .join("")}</ul></div>`
    : "";

export const renderForm = (page: FormPage): string => {
  const values = page.values ?? {};
  const row = (f: FormField) => {
    const hint = HINTS[f.path];
    return `
      <div class="field">
        <label for="attr:${escapeHtml(f.path)}">${escapeHtml(spanish(f.display, f.path))}${f.mandatory ? ' <span class="req" aria-hidden="true">*</span>' : ""}</label>
        ${input(f, values[f.path] ?? "")}
        ${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ""}
      </div>`;
  };
  const shown = page.fields.filter(
    (f) => f.valueType !== "object[]" && f.valueType !== "boolean",
  );
  const sectionOf = (f: FormField) => SECTIONS.find((s) => s.match(f.path));
  const rows = shown
    .filter((f) => !sectionOf(f))
    .map(row)
    .join("");
  // Folded sections open by themselves when they hold a value — after a refusal, for instance.
  const folded = SECTIONS.map((s) => {
    const fields = shown.filter((f) => sectionOf(f) === s);
    if (fields.length === 0) return "";
    const open = fields.some((f) => (values[f.path] ?? "") !== "") ? " open" : "";
    return `
      <details class="more"${open}>
        <summary>${escapeHtml(s.title)}${s.optional ? " (opcional)" : ""}</summary>
        ${fields.map(row).join("")}
      </details>`;
  }).join("");
  return shell(
    page.brand,
    "Solicitud de PID",
    `
    <nav class="crumbs">${escapeHtml(page.brand.crumbs)} › <strong>Solicitud de PID</strong></nav>
    <h1>Solicitud de datos de identificación personal (PID)</h1>
    <p class="lead">Complete sus datos para emitir <strong>${escapeHtml(page.credentialName)}</strong> en su cartera. Los campos marcados con <span class="req">*</span> son obligatorios.</p>
    ${errorBox(page.errors)}
    <form method="post" action="confirm" class="card">
      ${hidden(page.state)}
      <h2>Datos personales</h2>
      ${rows}
      ${folded}
      <div class="actions"><button type="submit">Confirmar</button></div>
    </form>`,
  );
};

// --- the representation flow: identify, then request ----------------------------------------

export const renderIdentify = (page: {
  readonly brand: Brand;
  readonly state: Readonly<Record<string, string>>;
  readonly credentialName: string;
  readonly errors?: readonly string[];
}): string =>
  shell(
    page.brand,
    "Identificación",
    `
    <nav class="crumbs">${escapeHtml(page.brand.crumbs)} › <strong>Identificación</strong></nav>
    <h1>Solicitud de ${escapeHtml(page.credentialName)}</h1>
    <p class="lead">Para solicitar esta credencial, identifíquese primero presentando su PID desde su cartera digital.</p>
    ${errorBox(page.errors)}
    <form method="post" action="identificarse" class="card">
      ${hidden(page.state)}
      <h2>Paso 1 de 2 · Identificación</h2>
      <p>Se abrirá su cartera y le pedirá compartir su nombre, apellidos, fecha de nacimiento, nacionalidad y país de nacimiento. Después volverá a esta página.</p>
      <div class="actions"><button type="submit">Identificarme con mi cartera</button></div>
    </form>`,
  );

export const renderOpenWallet = (page: {
  readonly brand: Brand;
  readonly walletUri: string;
}): string =>
  shell(
    page.brand,
    "Abrir la cartera",
    `
    <h1>Identificación con su cartera</h1>
    <div class="card">
      <h2>Paso 1 de 2 · Identificación</h2>
      <p>Pulse el botón para abrir su cartera y compartir su PID. Al terminar, la cartera le devolverá aquí.</p>
      <div class="actions"><a class="button" href="${escapeHtml(page.walletUri)}">Abrir mi cartera</a></div>
    </div>`,
  );

export const renderWaiting = (page: { readonly brand: Brand }): string =>
  shell(
    page.brand,
    "Comprobando",
    `
    <h1>Comprobando su identificación…</h1>
    <div class="card"><p>Esta página se actualizará sola en unos segundos.</p></div>`,
    '<meta http-equiv="refresh" content="3">',
  );

/** Readable values for the few code lists a person would otherwise see as numbers. */
const CODES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  EntityType: { "0": "Persona jurídica", "1": "Persona física" },
  AssuranceLevel: { "0": "Alto", "1": "Medio", "2": "Bajo" },
  IssuingAuthorityType: { "0": "QEAA", "1": "PubEAA", "2": "NQEAA (no cualificada)" },
  Type: { "0": "Orgánica", "1": "Voluntaria", "2": "Apud acta" },
  Limitation: { true: "Limitado", false: "Sin límites" },
};

const plain = (key: string, value: unknown): string => {
  const code = CODES[key]?.[String(value)];
  if (code) return code;
  if (Array.isArray(value)) return value.map((v) => plain(key, v)).join(", ");
  return String(value);
};

/** A fixed value, which may be a list of groups (a list of powers), as nested definition lists. */
const describe = (key: string, value: unknown): string => {
  if (Array.isArray(value) && value.some((v) => typeof v === "object" && v !== null)) {
    return value
      .map(
        (item, i) =>
          `<div class="group"><div class="group-title">${i + 1}</div>${Object.entries(
            item as Record<string, unknown>,
          )
            .map(
              ([k, v]) =>
                `<div class="kv"><span>${escapeHtml(k)}</span>${describe(k, v)}</div>`,
            )
            .join("")}</div>`,
      )
      .join("");
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `<div class="kv"><span>${escapeHtml(k)}</span>${describe(k, v)}</div>`)
      .join("");
  }
  return `<strong>${escapeHtml(plain(key, value))}</strong>`;
};

const PID_LABELS: Readonly<Record<string, string>> = {
  given_name: "Nombre",
  family_name: "Apellidos",
  birthdate: "Fecha de nacimiento",
  nationalities: "Nacionalidad",
  "place_of_birth.country": "País de nacimiento",
};

export const renderRequest = (page: {
  readonly brand: Brand;
  readonly state: Readonly<Record<string, string>>;
  readonly credentialName: string;
  readonly person: Readonly<Record<string, unknown>>;
  readonly fixed: readonly FixedClaim[];
  readonly errors?: readonly string[];
}): string => {
  // The verification result may carry a claim flat (`"a.b"`) or nested (`{a: {b}}`).
  const read = (path: string): unknown =>
    path in page.person
      ? page.person[path]
      : path
          .split(".")
          .reduce<unknown>(
            (node, key) =>
              typeof node === "object" && node !== null
                ? (node as Record<string, unknown>)[key]
                : undefined,
            page.person,
          );
  const person = Object.entries(PID_LABELS)
    .filter(([k]) => read(k) !== undefined)
    .map(
      ([k, label]) =>
        `<div class="kv"><span>${escapeHtml(label)}</span>${describe(k, read(k))}</div>`,
    )
    .join("");
  const fixed = page.fixed
    .map((f) => {
      const leaf = f.path.split(".").pop() ?? f.path;
      return `<div class="kv"><span>${escapeHtml(spanish(f.display, f.path))}</span>${describe(leaf, f.value)}</div>`;
    })
    .join("");
  return shell(
    page.brand,
    "Solicitud",
    `
    <nav class="crumbs">${escapeHtml(page.brand.crumbs)} › <strong>Solicitud</strong></nav>
    <h1>Solicitud de ${escapeHtml(page.credentialName)}</h1>
    <p class="lead">Identidad verificada. Revise los datos que figurarán en la credencial.</p>
    ${errorBox(page.errors)}
    <form method="post" action="solicitar" class="card">
      ${hidden(page.state)}
      <h2>Paso 2 de 2 · Solicitud</h2>
      <h3>Datos del representante (de su PID)</h3>
      <div class="kvs">${person}</div>
      <h3>Datos de la representación</h3>
      <div class="kvs">${fixed}</div>
      <div class="actions"><button type="submit">Solicitar</button></div>
    </form>`,
  );
};

export const renderMessage = (brand: Brand, title: string, body: string): string =>
  shell(
    brand,
    title,
    `<h1>${escapeHtml(title)}</h1><div class="card"><p>${escapeHtml(body)}</p></div>`,
  );

// --- the frame ------------------------------------------------------------------------------

const shell = (brand: Brand, title: string, main: string, head = ""): string => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${head}
<title>${escapeHtml(title)} — ${escapeHtml(brand.organisation)} (demostración)</title>
<style>
  :root { --brand:${brand.colour}; --brand-dark:${brand.colourDark}; --ink:#212529; --muted:#4d4d4d; --line:#e7e7e7; --bg:#f7f7f7; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif; color:var(--ink); background:var(--bg); }
  .demo { background:#fff4ce; color:#5c4400; border-bottom:1px solid #f0d77a; font-size:14px; padding:8px 16px; text-align:center; }
  .topbar { height:6px; background:var(--brand); }
  header { background:#fff; border-bottom:1px solid var(--line); }
  header .inner { max-width:960px; margin:0 auto; padding:14px 16px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
  header img { height:56px; width:auto; display:block; }
  header .mark { display:flex; align-items:center; gap:10px; font-weight:700; font-size:18px; color:var(--brand); }
  header .mark span { width:40px; height:40px; border-radius:8px; background:var(--brand); color:#fff; display:grid; place-items:center; font-size:20px; }
  header .service { color:var(--brand); font-weight:600; font-size:15px; text-align:right; }
  main { max-width:960px; margin:0 auto; padding:24px 16px 48px; }
  .crumbs { font-size:13px; color:var(--muted); margin-bottom:12px; }
  h1 { color:var(--brand); font-size:26px; margin:0 0 8px; font-weight:600; }
  h2 { color:var(--brand); font-size:18px; margin:0 0 16px; padding-bottom:8px; border-bottom:2px solid var(--brand); }
  h3 { font-size:15px; margin:20px 0 8px; color:var(--ink); }
  .lead { color:var(--muted); margin:0 0 20px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:4px; padding:24px; }
  .field { margin-bottom:18px; }
  label { display:block; font-weight:600; margin-bottom:6px; font-size:15px; }
  input, select { width:100%; max-width:420px; padding:10px 12px; font-size:16px; border:1px solid #bdbdbd; border-radius:3px; background:#fff; }
  input:focus, select:focus { outline:2px solid var(--brand); outline-offset:1px; border-color:var(--brand); }
  .hint { color:var(--muted); font-size:13px; margin:6px 0 0; }
  .more { border-top:1px solid var(--line); padding-top:14px; margin-top:8px; }
  .more summary { cursor:pointer; font-weight:600; color:var(--brand); margin-bottom:14px; }
  .req { color:#b00020; }
  .actions { margin-top:24px; }
  button, .button { display:inline-block; background:var(--brand); color:#fff; border:0; border-radius:3px; padding:12px 28px; font-size:16px; font-weight:600; cursor:pointer; text-decoration:none; }
  button:hover, .button:hover { background:var(--brand-dark); }
  .kvs { border-top:1px solid var(--line); }
  .kv { display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px; padding:8px 0; border-bottom:1px solid var(--line); font-size:15px; }
  .kv > span { color:var(--muted); }
  .kv .kv { font-size:14px; border-bottom:0; padding:4px 0; width:100%; }
  .group { width:100%; border-left:3px solid var(--line); padding-left:10px; margin:6px 0; }
  .group-title { font-size:12px; color:var(--muted); }
  .alert { background:#fdecea; border:1px solid #f5c2c0; color:#6b1a15; border-radius:4px; padding:12px 16px; margin-bottom:16px; }
  .alert ul { margin:8px 0 0; padding-left:20px; }
  footer { background:var(--brand); color:#fff; font-size:13px; opacity:.95; }
  footer .inner { max-width:960px; margin:0 auto; padding:18px 16px; }
</style>
</head>
<body>
  <div class="demo" role="note"><strong>Entorno de demostración.</strong> ${brand.client ? `No es un servicio de ${escapeHtml(brand.organisation)}.` : "No es un servicio real."} Use únicamente datos ficticios.</div>
  <div class="topbar"></div>
  <header><div class="inner">
    ${brand.logo ? `<img src="${escapeHtml(brand.logo)}" alt="${escapeHtml(brand.logoAlt)}">` : `<div class="mark" aria-label="${escapeHtml(brand.logoAlt)}"><span>D</span>${escapeHtml(brand.organisation)}</div>`}
    <div class="service">${escapeHtml(brand.service)}<br><span style="font-weight:400;color:#4d4d4d">${escapeHtml(brand.serviceSub)}</span></div>
  </div></header>
  <main>${main}</main>
  <footer><div class="inner">Demostración técnica — European Digital Trust Platform (entorno de pruebas).</div></footer>
</body>
</html>`;
