/**
 * The hosted PID form, rendered on the server. No script: the page is a form and a button.
 *
 * Styled after the issuing organisation's public site for a demonstration to that organisation —
 * its logo, its blue — and **always** carrying the demonstration band, so it cannot be taken for a
 * real service collecting real personal data. Every value typed here is expected to be fictitious.
 */

export interface FormField {
  readonly path: string;
  readonly display: readonly { readonly lang: string; readonly value: string }[];
  readonly valueType: string;
  readonly mandatory: boolean;
}

export interface PageInput {
  readonly tenant: string;
  readonly requestUri: string;
  readonly clientId: string;
  readonly credentialName: string;
  readonly fields: readonly FormField[];
  /** Values to put back after a refusal: the visitor's own input, in their own browser. */
  readonly values?: Readonly<Record<string, string>>;
  readonly errors?: readonly string[];
}

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

const label = (field: FormField): string =>
  field.display.find((d) => d.lang.startsWith("es"))?.value ??
  field.display.find((d) => d.lang.startsWith("en"))?.value ??
  field.path;

/** Guidance under the few fields whose expected form is not obvious. */
const HINTS: Readonly<Record<string, string>> = {
  nationalities:
    "Código de país de dos letras (ISO 3166-1), p. ej. ES. Varios, separados por comas.",
  "place_of_birth.country": "Código de país de dos letras, p. ej. ES.",
  personal_administrative_number: "DNI o NIE, sin espacios. Use un número ficticio.",
};

const input = (field: FormField, value: string): string => {
  const name = `attr:${escapeHtml(field.path)}`;
  const required = field.mandatory ? " required" : "";
  const common = `id="${name}" name="${name}" value="${escapeHtml(value)}"${required}`;
  switch (field.valueType) {
    case "date":
      return `<input type="date" ${common}>`;
    case "number":
    case "integer":
      return `<input type="number" ${common}>`;
    default: {
      const upper = field.path === "place_of_birth.country" || field.path === "nationalities";
      const extra = upper
        ? ` maxlength="${field.path === "nationalities" ? 30 : 2}" style="text-transform:uppercase"`
        : ` maxlength="200"`;
      return `<input type="text" autocomplete="off" ${common}${extra}>`;
    }
  }
};

export const renderForm = (page: PageInput): string => {
  const values = page.values ?? {};
  const rows = page.fields
    .filter((f) => f.valueType !== "object[]" && f.valueType !== "boolean")
    .map((f) => {
      const hint = HINTS[f.path];
      return `
      <div class="field">
        <label for="attr:${escapeHtml(f.path)}">${escapeHtml(label(f))}${f.mandatory ? ' <span class="req" aria-hidden="true">*</span>' : ""}</label>
        ${input(f, values[f.path] ?? "")}
        ${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ""}
      </div>`;
    })
    .join("");
  const errors =
    page.errors && page.errors.length > 0
      ? `<div class="alert" role="alert"><strong>No se ha podido emitir la credencial.</strong><ul>${page.errors
          .map((e) => `<li>${escapeHtml(e)}</li>`)
          .join("")}</ul></div>`
      : "";
  return shell(
    "Solicitud de PID",
    `
    <nav class="crumbs">Inicio › Cartera de Identidad Digital › <strong>Solicitud de PID</strong></nav>
    <h1>Solicitud de datos de identificación personal (PID)</h1>
    <p class="lead">Complete sus datos para emitir <strong>${escapeHtml(page.credentialName)}</strong> en su cartera. Los campos marcados con <span class="req">*</span> son obligatorios.</p>
    ${errors}
    <form method="post" action="confirm" class="card">
      <input type="hidden" name="tenant" value="${escapeHtml(page.tenant)}">
      <input type="hidden" name="request_uri" value="${escapeHtml(page.requestUri)}">
      <input type="hidden" name="client_id" value="${escapeHtml(page.clientId)}">
      <h2>Datos personales</h2>
      ${rows}
      <div class="actions">
        <button type="submit">Confirmar</button>
      </div>
    </form>`,
  );
};

export const renderMessage = (title: string, body: string): string =>
  shell(
    title,
    `<h1>${escapeHtml(title)}</h1><div class="card"><p>${escapeHtml(body)}</p></div>`,
  );

const shell = (title: string, main: string): string => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} — FNMT-RCM (demostración)</title>
<style>
  :root { --fnmt:#1a3b88; --fnmt-dark:#122a63; --ink:#212529; --muted:#4d4d4d; --line:#e7e7e7; --bg:#f7f7f7; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif; color:var(--ink); background:var(--bg); }
  .demo { background:#fff4ce; color:#5c4400; border-bottom:1px solid #f0d77a; font-size:14px; padding:8px 16px; text-align:center; }
  .topbar { height:6px; background:var(--fnmt); }
  header { background:#fff; border-bottom:1px solid var(--line); }
  header .inner { max-width:960px; margin:0 auto; padding:14px 16px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
  header img { height:56px; width:auto; display:block; }
  header .service { color:var(--fnmt); font-weight:600; font-size:15px; text-align:right; }
  main { max-width:960px; margin:0 auto; padding:24px 16px 48px; }
  .crumbs { font-size:13px; color:var(--muted); margin-bottom:12px; }
  h1 { color:var(--fnmt); font-size:26px; margin:0 0 8px; font-weight:600; }
  h2 { color:var(--fnmt); font-size:18px; margin:0 0 16px; padding-bottom:8px; border-bottom:2px solid var(--fnmt); }
  .lead { color:var(--muted); margin:0 0 20px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:4px; padding:24px; }
  .field { margin-bottom:18px; }
  label { display:block; font-weight:600; margin-bottom:6px; font-size:15px; }
  input { width:100%; max-width:420px; padding:10px 12px; font-size:16px; border:1px solid #bdbdbd; border-radius:3px; background:#fff; }
  input:focus { outline:2px solid var(--fnmt); outline-offset:1px; border-color:var(--fnmt); }
  .hint { color:var(--muted); font-size:13px; margin:6px 0 0; }
  .req { color:#b00020; }
  .actions { margin-top:24px; }
  button { background:var(--fnmt); color:#fff; border:0; border-radius:3px; padding:12px 28px; font-size:16px; font-weight:600; cursor:pointer; }
  button:hover { background:var(--fnmt-dark); }
  .alert { background:#fdecea; border:1px solid #f5c2c0; color:#6b1a15; border-radius:4px; padding:12px 16px; margin-bottom:16px; }
  .alert ul { margin:8px 0 0; padding-left:20px; }
  footer { background:var(--fnmt); color:#dfe6f5; font-size:13px; }
  footer .inner { max-width:960px; margin:0 auto; padding:18px 16px; }
</style>
</head>
<body>
  <div class="demo" role="note"><strong>Entorno de demostración.</strong> No es un servicio de la FNMT-RCM. Use únicamente datos ficticios.</div>
  <div class="topbar"></div>
  <header><div class="inner">
    <img src="assets/fnmt-logo.png" alt="FNMT — Real Casa de la Moneda">
    <div class="service">Cartera de Identidad Digital<br><span style="font-weight:400;color:#4d4d4d">Emisión de PID</span></div>
  </div></header>
  <main>${main}</main>
  <footer><div class="inner">Demostración técnica — European Digital Trust Platform (entorno de pruebas).</div></footer>
</body>
</html>`;
