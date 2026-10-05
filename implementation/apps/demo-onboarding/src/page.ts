import { FIELDS } from "./claims.js";
import type { Dictionary } from "./i18n.js";

/**
 * The shell of the onboarding demonstration, and its stylesheet. The screens are built by the
 * page's script (`client.ts`); the shell is what every one of them sits in.
 *
 * **Banco Horizonte is fictitious.** The palette is the one the demonstration's specification asks
 * for; the name, the mark and the typeface belong to no real bank. The demonstration band is in the
 * shell, so no screen can be shown without it.
 */

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  // The page talks only to its own process. Every platform call is made server-side.
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

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

/** JSON for a data block: `<` escaped, so no value can close the element it sits in. */
const dataBlock = (id: string, value: unknown): string =>
  `<script type="application/json" id="${id}">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`;

export interface ShellOptions {
  readonly lang: string;
  readonly t: Dictionary;
  /** The versioned path of the assets, so a cached stylesheet or script is never a stale one. */
  readonly assets: string;
  /** Whether a presentation policy is configured. Without one the page plays the recording. */
  readonly live: boolean;
  /** A presentation the wallet has just returned from, same-device. */
  readonly resume?: string;
  readonly recorded: unknown;
}

export const renderShell = (o: ShellOptions): string => {
  const t = o.t;
  const e = escapeHtml;
  return `<!doctype html>
<html lang="${e(o.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${e(t.productTitle)} — Banco Horizonte (demostración)</title>
<link rel="stylesheet" href="${e(o.assets)}/app.css">
</head>
<body>
  <div class="demo" role="note">${e(t.band)}</div>
  <div class="ribbon" id="ribbon" role="status" hidden>${e(t.recordedRibbon)}</div>
  <header class="top">
    <div class="bar">
      <a class="brand" href="./"><span class="mark" aria-hidden="true"></span><span>Banco Horizonte<small>${e(t.brandSub)}</small></span></a>
      <nav class="menu" aria-label="Banco Horizonte">
        <span>${e(t.menuPersonal)}</span><span>${e(t.menuBusiness)}</span><span>${e(t.menuPrivate)}</span><span>${e(t.menuHelp)}</span>
      </nav>
      <span class="access">${e(t.clientAccess)}</span>
    </div>
  </header>
  <div class="presenter">
    <span class="presenter-keys">${e(t.shortcuts)}</span>
    <button type="button" class="btn btn-link" id="restart">${e(t.restart)}</button>
    <button type="button" class="btn btn-link" id="tech-toggle">${e(t.techToggle)}</button>
  </div>
  <main id="app"></main>
  <aside id="tech" class="tech" hidden aria-label="${e(t.techTitle)}">
    <div class="tech-head">
      <strong>${e(t.techTitle)}</strong>
      <button type="button" class="btn btn-link" id="tech-view">${e(t.techTechnical)}</button>
      <button type="button" class="btn btn-link" id="tech-close" aria-label="×">×</button>
    </div>
    <ol id="tech-events" class="tech-events"></ol>
  </aside>
  <footer>
    <div class="seals"><span>🔒 ${e(t.footerSecure)}</span><span>${e(t.footerTest)}</span><span>${e(t.footerPrivacy)}</span></div>
    <p>${e(t.footerLegal)}</p>
  </footer>
  ${dataBlock("i18n", t)}
  ${dataBlock("cfg", {
    live: o.live,
    resume: o.resume ?? null,
    fields: FIELDS,
    recorded: o.recorded,
  })}
  <script src="${e(o.assets)}/app.js" defer></script>
</body>
</html>`;
};

/** A page with no script: an error, a 404, a rate limit. The band is on it too. */
export const renderPlain = (
  t: Dictionary,
  title: string,
  body: string,
  assets: string,
): string =>
  `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} — Banco Horizonte (demostración)</title>
<link rel="stylesheet" href="${escapeHtml(assets)}/app.css">
</head>
<body>
  <div class="demo" role="note">${escapeHtml(t.band)}</div>
  <header class="top"><div class="bar"><a class="brand" href="./"><span class="mark" aria-hidden="true"></span><span>Banco Horizonte<small>${escapeHtml(t.brandSub)}</small></span></a></div></header>
  <main><section class="screen"><h1>${escapeHtml(title)}</h1><p class="lead">${escapeHtml(body)}</p></section></main>
</body>
</html>`;

export const APP_CSS = `
:root {
  --primary:#007EAE; --primary-dark:#00476B; --primary-light:#E5F2F7; --yellow:#FFC600; --red:#D6002A;
  --success:#1E8A5A; --text:#1A1A1A; --muted:#5F6B73; --bg:#FFFFFF; --bg-alt:#F4F6F8; --line:#DDE3E8;
}
* { box-sizing:border-box; }
html { font-size:16px; }
body { margin:0; font-family:Inter, "Open Sans", -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color:var(--text); background:var(--bg-alt); line-height:1.45; }
h1, h2 { font-weight:600; color:var(--primary-dark); margin:0 0 12px; }
h1 { font-size:28px; } h2 { font-size:19px; margin-top:28px; }
[hidden] { display:none !important; }
.demo { background:#FFF4CE; color:#5C4400; border-bottom:1px solid #F0D77A; font-size:13px; padding:7px 16px; text-align:center; }
.ribbon { background:var(--red); color:#fff; font-weight:600; font-size:14px; padding:8px 16px; text-align:center; }
.top { background:var(--primary-dark); color:#fff; }
.bar { max-width:1280px; margin:0 auto; padding:14px 24px; display:flex; align-items:center; gap:32px; }
.brand { display:flex; align-items:center; gap:12px; color:#fff; text-decoration:none; font-weight:600; font-size:20px; }
.brand small { display:block; font-weight:400; font-size:12px; opacity:.8; }
.mark { width:36px; height:36px; border-radius:50%; background:linear-gradient(180deg, var(--yellow) 0 50%, var(--primary) 50% 100%); border:2px solid #fff; }
.menu { display:flex; gap:24px; font-size:15px; flex:1; opacity:.92; }
.access { border:1px solid rgba(255,255,255,.7); border-radius:999px; padding:8px 18px; font-size:14px; font-weight:600; }
.presenter { max-width:1280px; margin:0 auto; padding:6px 24px; display:flex; justify-content:flex-end; align-items:center; gap:12px; color:var(--muted); font-size:12px; }
main { max-width:1280px; margin:0 auto; padding:8px 24px 56px; min-height:60vh; }
footer { background:var(--primary-dark); color:#fff; padding:24px; text-align:center; font-size:12px; }
footer p { opacity:.8; max-width:760px; margin:10px auto 0; }
.seals { display:flex; gap:20px; justify-content:center; flex-wrap:wrap; font-size:13px; }
.lead { color:var(--muted); margin:0 0 20px; font-size:17px; }
.note { color:var(--muted); font-size:13px; }
.friction { color:var(--red); }
.good { color:var(--success); }

.btn { font:inherit; font-weight:600; font-size:15px; border-radius:999px; padding:12px 26px; border:1px solid transparent; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:10px; transition:background .3s, color .3s; }
.btn-primary { background:var(--primary); color:#fff; }
.btn-primary:hover { background:var(--primary-dark); }
.btn-secondary { background:#fff; color:var(--primary); border-color:var(--primary); }
.btn-outline { background:transparent; color:var(--primary-dark); border-color:var(--primary-dark); }
.btn-link { background:none; border:0; padding:4px 6px; color:var(--primary); font-size:13px; border-radius:4px; }
.btn-wide { padding:15px 30px; font-size:16px; }
.badge-new { background:var(--yellow); color:#1A1A1A; font-size:11px; font-weight:700; border-radius:999px; padding:2px 9px; text-transform:uppercase; letter-spacing:.4px; }
.actions { display:flex; gap:12px; flex-wrap:wrap; margin-top:24px; }
.actions.center { justify-content:center; }
.chip { display:inline-block; background:var(--primary-light); color:var(--primary-dark); border-radius:999px; font-size:12px; padding:3px 10px; margin-left:6px; font-weight:500; }
.chip-muted { background:#E9EDF0; color:var(--muted); }
.chip-warn { background:#FFE9A8; color:#5C4400; }
.chip-friction { background:#FBE5EA; color:var(--red); }

.cover { text-align:center; padding-top:32px; }
.cover-cards { display:grid; grid-template-columns:repeat(2, minmax(0, 420px)); gap:24px; justify-content:center; margin-top:28px; }
.cover-card { background:#fff; border:1px solid var(--line); border-radius:16px; padding:32px 28px; text-align:left; position:relative; display:flex; flex-direction:column; gap:6px; }
.cover-card.eudi { background:var(--primary-light); border-color:var(--primary); }
.cover-card .badge-new { position:absolute; top:16px; right:16px; }
.cover-card h2 { margin-top:0; font-size:22px; }
.cover-card p { color:var(--muted); flex:1; margin:0 0 18px; }
.cover-card .btn { align-self:flex-start; }

.cover-more { max-width:864px; margin:28px auto 0; background:#fff; border:1px solid var(--line); border-radius:16px; padding:20px 28px; display:flex; align-items:center; justify-content:space-between; gap:20px; text-align:left; }
.cover-more h2 { margin:0 0 4px; } .cover-more p { margin:0; color:var(--muted); }
.loan-sim { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:20px; align-items:end; background:#fff; border-radius:12px; padding:20px; margin-top:8px; }
.loan-sim input[type=range] { padding:0; min-height:28px; border:0; accent-color:var(--primary); }
.loan-amount, .loan-quota { display:block; font-size:26px; color:var(--primary-dark); }
.loan-result small { display:block; color:var(--muted); font-size:12px; }
.loan-result span { display:block; font-size:13px; color:var(--muted); }
.pane { background:#fff; border:1px solid var(--line); border-radius:16px; overflow:hidden; min-width:0; }
.pane-solo { max-width:980px; margin:8px auto 0; }
.flow-head { display:flex; flex-wrap:wrap; align-items:center; gap:10px 16px; padding:14px 24px 0; position:relative; }
.flow-mode { font-weight:600; color:var(--primary-dark); }
.flow-chips { flex:1; }
.flow-step { color:var(--muted); font-size:14px; }
.flow-clock { background:var(--primary-dark); color:#fff; border-radius:8px; padding:5px 12px; font-variant-numeric:tabular-nums; font-weight:600; display:inline-flex; gap:8px; align-items:baseline; }
.flow-clock-label { font-size:11px; font-weight:400; opacity:.8; text-transform:uppercase; }
.progress { flex-basis:100%; height:4px; background:var(--bg-alt); margin:6px -24px 0; }
.progress-fill { height:100%; width:0; background:var(--primary); transition:width .3s; }
.flow-body { padding:28px 32px 36px; }
.screen { animation:in .3s ease; }
@keyframes in { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }

.hero { background:linear-gradient(135deg, var(--primary-light), #fff 70%); border-radius:12px; padding:36px 32px; }
.hero h1 { font-size:34px; }
.benefits { list-style:none; padding:0; margin:0; display:grid; gap:8px; }
.benefits li::before { content:"✓"; color:var(--success); font-weight:700; margin-right:10px; }
.asked { list-style:none; padding:0; margin:0; display:grid; gap:10px; max-width:560px; }
.asked li { display:flex; gap:14px; align-items:center; background:var(--bg-alt); border-radius:10px; padding:12px 16px; }
.asked-icon { font-size:22px; }
.asked-text small { display:block; color:var(--muted); }

.connect { display:grid; grid-template-columns:minmax(0, 1fr) 300px; gap:32px; align-items:start; }
.connect-box { display:flex; flex-direction:column; align-items:flex-start; gap:10px; }
.qr { width:260px; height:260px; padding:10px; background:#fff; border:2px solid var(--primary); border-radius:12px; }
.qr svg { width:100%; height:100%; display:block; }
.qr-recorded { display:grid; place-items:center; color:var(--muted); font-weight:700; font-size:40px; border-style:dashed; }
.qr-caption { font-weight:600; margin:0; }
.status { list-style:none; padding:0; margin:18px 0 0; display:flex; gap:8px; flex-wrap:wrap; }
.status li { font-size:13px; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:5px 12px; transition:all .3s; }
.status li.now { color:var(--primary-dark); border-color:var(--primary); background:var(--primary-light); animation:pulse 1.4s infinite; }
.status li.done { color:#fff; background:var(--success); border-color:var(--success); }
@keyframes pulse { 50% { opacity:.55; } }
.error { margin-top:16px; background:#FBE5EA; color:var(--red); border-radius:8px; padding:12px 16px; font-weight:600; }
.phone-wrap { margin:0; text-align:center; }
.phone-wrap figcaption { color:var(--muted); font-size:12px; margin-top:8px; }
.phone { width:260px; margin:0 auto; background:#1A1A1A; border-radius:34px; padding:12px; }
.phone-screen { background:#fff; border-radius:24px; padding:22px 16px; min-height:420px; text-align:left; font-size:14px; }
.phone-title { font-weight:600; color:var(--primary-dark); margin-bottom:12px; }
.phone-list { list-style:none; padding:0; margin:0 0 14px; display:grid; gap:8px; }
.phone-check { display:inline-grid; place-items:center; width:18px; height:18px; border-radius:4px; background:var(--muted); color:#fff; font-size:11px; margin-right:8px; }
.phone-body { color:var(--muted); font-size:13px; }
.phone-pin { text-align:center; letter-spacing:4px; color:var(--primary); margin-top:18px; }

.form { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:14px 20px; }
.field label { display:block; font-size:13px; color:var(--muted); margin-bottom:4px; }
.field-value, .field input, .field select { width:100%; min-height:44px; border:1px solid var(--line); border-radius:8px; padding:10px 12px; font:inherit; background:#fff; }
.field-value.typing::after { content:"▏"; color:var(--primary); }
.field-verified { opacity:.25; transition:opacity .3s; }
.field-verified.in { opacity:1; }
.field-verified.in .field-value { border-color:var(--success); background:#F1FAF5; }
.seal { display:none; align-items:center; gap:6px; color:var(--success); font-size:12px; font-weight:600; margin-top:4px; }
.field-verified.in .seal { display:inline-flex; }
.seal-icon { display:inline-grid; place-items:center; width:20px; height:20px; border-radius:50%; background:#003399; box-shadow:inset 0 0 0 2px var(--yellow); font-size:10px; }
.adult { color:var(--success); font-weight:600; font-size:14px; }
.summary { background:var(--bg-alt); border-radius:12px; padding:18px 20px; max-width:560px; }
.kv { display:flex; justify-content:space-between; gap:16px; padding:8px 0; border-bottom:1px solid var(--line); }
.kv:last-of-type { border-bottom:0; }
.kv span { color:var(--muted); }
.check { display:flex; gap:10px; align-items:center; padding-top:12px; font-size:14px; }
.otp { margin-top:24px; border-top:1px solid var(--line); padding-top:8px; }
.otp-digits { display:flex; gap:8px; margin:12px 0; }
.otp-cell { width:42px; height:50px; border:1px solid var(--primary); border-radius:8px; display:grid; place-items:center; font-size:22px; font-weight:600; }
.success { text-align:center; }
.success-mark { width:64px; height:64px; border-radius:50%; background:var(--success); color:#fff; font-size:34px; display:grid; place-items:center; margin:0 auto 14px; }
.success-grid { display:flex; gap:20px; justify-content:center; flex-wrap:wrap; text-align:left; }
.bank-card { width:260px; height:150px; border-radius:14px; background:linear-gradient(135deg, var(--primary), var(--primary-dark)); color:#fff; padding:18px; display:flex; flex-direction:column; justify-content:space-between; font-size:13px; }
.bank-card-brand { font-weight:600; font-size:17px; }
.bank-card-number { letter-spacing:2px; font-size:16px; }
.metrics { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:12px; margin:24px auto 0; max-width:720px; }
.metric { background:var(--primary-light); border-radius:12px; padding:14px 8px; }
.metric strong { display:block; font-size:22px; color:var(--primary-dark); }
.metric span { font-size:12px; color:var(--muted); }
.success .actions { justify-content:center; }

.capture-wrap { display:inline-block; vertical-align:top; margin:0 24px 16px 0; text-align:center; }
.capture-label { font-size:13px; color:var(--muted); margin-bottom:6px; }
.capture { width:220px; height:140px; border-radius:12px; border:3px dashed var(--line); background:var(--bg-alt); transition:border-color .3s; }
.capture.round { width:170px; height:170px; border-radius:50%; }
.capture.busy { border-color:var(--primary); animation:pulse 1.2s infinite; }
.capture.fail { border-color:var(--red); border-style:solid; }
.capture.ok { border-color:var(--success); border-style:solid; }
.capture-msg { min-height:22px; font-size:14px; font-weight:600; margin-top:8px; }
.review { text-align:center; }
.hourglass { font-size:54px; }

.side-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:20px; align-items:start; }
.side .flow-body { padding:20px; }
.side .form { grid-template-columns:1fr; gap:8px; }
.side .connect { grid-template-columns:1fr; }
.side h1 { font-size:22px; } .side .hero h1 { font-size:26px; } .side .hero { padding:22px; }
.side .field-value, .side .field input, .side .field select { min-height:36px; padding:6px 10px; }
.side-banner { background:var(--success); color:#fff; border-radius:12px; padding:14px 20px; margin-bottom:16px; display:flex; gap:16px; align-items:center; justify-content:space-between; font-weight:600; }
.side-banner .btn { background:#fff; color:var(--success); }

.compare { max-width:860px; margin:24px auto 0; text-align:center; }
.compare-table { width:100%; border-collapse:collapse; background:#fff; border-radius:16px; overflow:hidden; text-align:left; }
.compare-table th, .compare-table td { padding:16px 20px; border-bottom:1px solid var(--line); font-size:16px; }
.compare-table tr:first-child th { background:var(--primary-dark); color:#fff; }
.compare-table th.col-eudi { background:var(--primary); }
.compare-table td:nth-child(2) { color:var(--red); }
.compare-table td:nth-child(3) { color:var(--success); font-weight:600; }

.tech { position:fixed; top:0; right:0; bottom:0; width:380px; max-width:100vw; background:#0F2A3A; color:#E6EEF2; padding:18px; overflow:auto; z-index:10; box-shadow:-8px 0 24px rgba(0,0,0,.2); }
.tech-open main, .tech-open .presenter, .tech-open .bar { margin-right:380px; }
.tech-head { display:flex; align-items:center; gap:8px; margin-bottom:14px; }
.tech-head strong { flex:1; }
.tech .btn-link { color:#8FD3EE; }
.tech-events { list-style:none; margin:0; padding:0; display:grid; gap:12px; }
.tech-event { border-left:3px solid var(--primary); padding:2px 0 2px 12px; animation:in .3s ease; }
.tech-event-head { display:flex; gap:10px; }
.tech-n { display:inline-grid; place-items:center; min-width:22px; height:22px; border-radius:50%; background:var(--primary); font-size:12px; font-weight:700; }
.tech-label { font-size:14px; }
.tech-meta { font-size:11px; opacity:.8; margin:4px 0 0 32px; }
.tech details { margin:6px 0 0 32px; font-size:12px; }
.tech pre { background:#081C27; border-radius:6px; padding:10px; overflow:auto; white-space:pre-wrap; word-break:break-word; }
.tech-empty { opacity:.7; font-size:13px; }

@media (max-width:1100px) { .tech-open main, .tech-open .presenter, .tech-open .bar { margin-right:auto; } }
@media (max-width:720px) {
  .menu, .presenter-keys { display:none; }
  .bar { padding:12px 16px; gap:12px; justify-content:space-between; }
  main { padding:8px 12px 40px; }
  h1 { font-size:23px; } .hero h1 { font-size:26px; }
  .flow-body { padding:20px 16px 28px; } .flow-head { padding:12px 16px 0; } .progress { margin:6px -16px 0; }
  .cover-cards, .form, .side-grid, .connect, .loan-sim { grid-template-columns:1fr; }
  .cover-more { flex-direction:column; align-items:flex-start; }
  .metrics { grid-template-columns:repeat(2, minmax(0, 1fr)); }
  .phone-wrap { display:none; }
  .btn-wide { width:100%; justify-content:center; }
  .compare-table th, .compare-table td { padding:10px 8px; font-size:14px; }
  .side-banner { flex-direction:column; align-items:flex-start; }
}
`;
