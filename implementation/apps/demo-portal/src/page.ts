/**
 * The demonstration portal, rendered on the server. No script: the QR codes are inline SVG made here,
 * and the status dots are read on the server when the page is built.
 *
 * Neutral look, no real organisation named (ADR 0010 §2). The demonstration band is on every page.
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

export type Health = "up" | "down";

export interface DemoCard {
  readonly key: string;
  readonly title: string;
  readonly summary: string;
  /** What the visitor does, step by step. */
  readonly steps: readonly string[];
  /** A page to open, when the demonstration starts on a web page rather than in the wallet. */
  readonly url?: string;
  /** Inline SVG of a QR carrying `url`: the page address only, never a wallet request (ADR 0009). */
  readonly qrSvg?: string;
  readonly health: Health;
}

const dot = (health: Health): string =>
  `<span class="dot ${health}" role="img" aria-label="${health === "up" ? "Disponible" : "No disponible"}"></span>${
    health === "up" ? "Disponible" : "No disponible ahora"
  }`;

const card = (c: DemoCard): string => `
  <article class="card" id="${escapeHtml(c.key)}">
    <div class="card-head">
      <h2>${escapeHtml(c.title)}</h2>
      <div class="status">${dot(c.health)}</div>
    </div>
    <p class="summary">${escapeHtml(c.summary)}</p>
    <div class="card-body">
      <ol>${c.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
      ${c.qrSvg ? `<div class="qr" aria-label="Código QR con la dirección de la página">${c.qrSvg}<span>Escanéelo con la cámara del móvil</span></div>` : ""}
    </div>
    ${c.url ? `<div class="actions"><a class="button" href="${escapeHtml(c.url)}">Abrir en este móvil</a></div>` : ""}
  </article>`;

export const renderHome = (cards: readonly DemoCard[]): string =>
  shell(
    "Demostraciones",
    `
    <h1>Demostraciones de identidad digital europea</h1>
    <p class="lead">Credenciales verificables emitidas y verificadas por la plataforma, con una cartera en el móvil: un PID de prueba, credenciales de representación de empresa, y dos webs ficticias que las piden.</p>
    <div class="notice">
      <strong>Necesita la cartera de prueba EDTP</strong> (Android), no la de la tienda de aplicaciones: es una versión modificada que confía en nuestras autoridades de prueba. Las demostraciones se hacen normalmente con nuestros propios móviles.
    </div>
    <div class="cards">${cards.map(card).join("")}</div>`,
  );

export interface ChecksStatus {
  readonly at: string;
  readonly result: "pass" | "exposed" | "unreachable" | string;
  readonly summary: string;
}

export interface OperatorView {
  readonly who: string;
  readonly checks?: ChecksStatus;
  readonly profile: string;
  readonly clientProfileOn: boolean;
  readonly links: readonly { readonly label: string; readonly url: string }[];
}

export const renderOperator = (view: OperatorView): string =>
  shell(
    "Operador",
    `
    <nav class="crumbs"><a href="./">Demostraciones</a> › <strong>Operador</strong></nav>
    <h1>Vista de operador</h1>
    <p class="lead">Sesión de <!--email_off-->${escapeHtml(view.who)}<!--/email_off--> (Cloudflare Access).</p>
    <section class="card">
      <h2>Comprobaciones negativas</h2>
      ${
        view.checks
          ? `<p><span class="dot ${view.checks.result === "pass" ? "up" : "down"}"></span> <strong>${
              view.checks.result === "pass"
                ? "Correctas"
                : view.checks.result === "exposed"
                  ? "FALLIDAS: túnel detenido"
                  : "No se pudieron completar"
            }</strong> — ${escapeHtml(view.checks.at)}</p><p class="lead">${escapeHtml(view.checks.summary)}</p>`
          : "<p>Aún no hay resultados.</p>"
      }
      <p class="lead">Cada 15 minutos. Si una ruta prohibida responde, el túnel se detiene (ADR 0010 §3).</p>
    </section>
    <section class="card">
      <h2>Perfil de marca</h2>
      <p>Activo: <strong>${escapeHtml(view.profile)}</strong>${view.clientProfileOn ? " — vuelve solo a genérico a las 4 horas de activarse." : ""}</p>
      <p>Se cambia en el servidor, por SSH (ADR 0010). Un perfil de cliente requiere el permiso por escrito de la organización:</p>
      <pre>ssh -F ~/.edtp/demo-vm/ssh_config edtp-demo \\
  '~/edtp/implementation/infra/demo-vm/demo-profile.sh fnmt-corpme'   # o: generic</pre>
    </section>
    <section class="card">
      <h2>Enlaces</h2>
      <ul>${view.links.map((l) => `<li><a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a></li>`).join("")}</ul>
    </section>
    <section class="card">
      <h2>Cartera de prueba (APK)</h2>
      <p>Pendiente: se publicará aquí, solo tras el login, como build <em>release</em> con los términos de la EUPL 1.2 y tras la confirmación legal (ADR 0010 §4).</p>
    </section>`,
  );

export const renderForbidden = (): string =>
  shell(
    "Acceso restringido",
    `
    <h1>Acceso restringido</h1>
    <div class="card"><p>Esta sección solo está disponible tras iniciar sesión.</p></div>
    <div class="actions"><a class="button" href="./">Volver a las demostraciones</a></div>`,
  );

const shell = (title: string, main: string): string => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} — EDTP Demo</title>
<style>
  :root { --brand:#2f4858; --brand-dark:#1f3140; --line:#dfe4ea; --muted:#5b6770; --bg:#f3f5f8; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system, "Segoe UI", Roboto, Arial, sans-serif; color:#1c2328; background:var(--bg); }
  .demo { background:#fff4ce; color:#5c4400; border-bottom:1px solid #f0d77a; font-size:14px; padding:8px 16px; text-align:center; }
  header { background:var(--brand); color:#fff; }
  .bar { max-width:1040px; margin:0 auto; padding:14px 16px; display:flex; align-items:center; gap:12px; }
  .mark { width:34px; height:34px; border-radius:8px; background:#fff; color:var(--brand); display:grid; place-items:center; font-weight:800; }
  .brand { font-weight:700; font-size:19px; }
  .brand small { display:block; font-weight:400; font-size:12px; opacity:.85; }
  main { max-width:1040px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:26px; margin:0 0 10px; color:var(--brand); }
  h2 { font-size:18px; margin:0; color:var(--brand); }
  .lead { color:var(--muted); margin:0 0 18px; max-width:760px; }
  .crumbs { color:var(--muted); font-size:13px; margin-bottom:12px; }
  .crumbs a { color:var(--muted); }
  .notice { background:#eef3f7; border:1px solid #cfdbe5; border-radius:8px; padding:14px 16px; margin-bottom:22px; font-size:15px; }
  .cards { display:grid; gap:16px; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:20px; margin-bottom:16px; display:flex; flex-direction:column; }
  .cards .card { margin-bottom:0; }
  .card-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
  .status { font-size:13px; color:var(--muted); white-space:nowrap; display:flex; align-items:center; gap:6px; }
  .dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
  .dot.up { background:#1f9d55; }
  .dot.down { background:#c0392b; }
  .summary { color:var(--muted); margin:8px 0 12px; }
  .card-body { display:flex; gap:16px; align-items:flex-start; flex:1; }
  .card-body ol { margin:0; padding-left:20px; font-size:15px; flex:1; }
  .card-body li { margin-bottom:6px; }
  .qr { width:128px; flex:none; text-align:center; font-size:11px; color:var(--muted); }
  .qr svg { width:128px; height:128px; display:block; }
  .actions { margin-top:16px; }
  .button { display:inline-block; background:var(--brand); color:#fff; border-radius:6px; padding:11px 20px; font-size:15px; font-weight:600; text-decoration:none; }
  .button:hover { background:var(--brand-dark); }
  pre { background:#f6f8fa; border:1px solid var(--line); border-radius:6px; padding:10px; overflow-x:auto; font-size:13px; }
  footer { color:var(--muted); font-size:12px; text-align:center; padding:20px 16px 32px; }
  @media (max-width: 520px) { .card-body { flex-direction:column; } .qr { display:none; } }
</style>
</head>
<body>
  <div class="demo" role="note"><strong>Entorno de demostración.</strong> Datos ficticios; nada de lo que aquí se emite o verifica tiene validez. No es un servicio de ninguna administración ni empresa real.</div>
  <header><div class="bar"><div class="mark" aria-hidden="true">D</div><div class="brand">EDTP Demo<small>European Digital Trust Platform</small></div></div></header>
  <main>${main}</main>
  <footer>Entorno de pruebas (TEST). Sin conformidad declarada con el ARF ni con ninguna especificación técnica.</footer>
</body>
</html>`;
