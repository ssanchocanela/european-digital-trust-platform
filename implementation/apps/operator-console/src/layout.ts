import { html, rawHtml, type SafeHtml, toHtmlString } from "./html.js";

/**
 * The page shell.
 *
 * Two things in here are not decoration.
 *
 * **The environment banner.** The console states `TEST` at the top of every page, for the same reason
 * the test wallet carries a banner: a screenshot has to say what produced it. V0 supports `TEST` only
 * (`CLAUDE.md` §7), and a console that looked the same in both would make that distinction invisible
 * exactly when it matters.
 *
 * **A restrictive `Content-Security-Policy`, and therefore no inline script.** The page's own JavaScript
 * is served as a file with a hash, not inlined, so `script-src 'self'` can hold without
 * `'unsafe-inline'`. That is the control that makes the escaping in `html.ts` a second line of defence
 * rather than the only one.
 */

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  // The console talks only to itself. Every platform call is server-side.
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface LayoutOptions {
  readonly title: string;
  readonly trustEnvironment: string;
  /** Rendered in the header, so every page says which tenant's key this console holds. */
  readonly tenantHint: string;
  readonly body: SafeHtml;
  readonly authenticated: boolean;
}

export const page = (options: LayoutOptions): string =>
  toHtmlString(html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${options.title} — EDTP operator console</title>
<link rel="stylesheet" href="/assets/console.css">
</head>
<body>
<div class="env-banner">
  ${options.trustEnvironment} ENVIRONMENT · V0 · NOT PRODUCTION-READY · NO ARF OR TS CONFORMANCE CLAIMED
</div>
<header class="top">
  <span class="brand">EDTP operator console</span>
  <span class="tenant">tenant ${options.tenantHint}</span>
  ${
    options.authenticated
      ? rawHtml(
          '<nav><a href="/">Test driver</a> <a href="/health">Health</a>' +
            '<form method="post" action="/logout" class="inline"><button type="submit">Sign out</button></form></nav>',
        )
      : ""
  }
</header>
<main>
${options.body}
</main>
<footer>
  <p>
    This console renders exactly what the platform API returns. It has no privileged view and no raw
    response view, by design — see <code>docs/web-interface-proposal.md</code> §3.1.
  </p>
</footer>
</body>
</html>
`);

/** A banner for a recoverable problem. The message is escaped; it can come from the API. */
export const notice = (kind: "error" | "warn" | "info", message: string): SafeHtml =>
  html`<p class="notice ${kind}">${message}</p>`;

/**
 * The stylesheet, served as a file so the CSP needs no `'unsafe-inline'`.
 *
 * Plain CSS, light and dark, no framework. The console is forms and tables.
 */
export const CONSOLE_CSS = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --fg: #1d1d1b; --muted: #5f5f5a; --line: #d9d9d4;
  --panel: #ffffff; --accent: #1a4f8a; --warn: #8a5a00; --error: #8a1c1c; --ok: #1f6b3a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16171a; --fg: #e9e9e6; --muted: #a0a09a; --line: #33353a;
    --panel: #1d1f23; --accent: #7fb3ee; --warn: #e0a54a; --error: #ef8a8a; --ok: #7fd1a0;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.env-banner {
  background: var(--error); color: #fff; text-align: center; font-size: 11px;
  font-weight: 700; letter-spacing: .04em; padding: 5px 8px;
}
header.top {
  display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
  padding: 10px 20px; border-bottom: 1px solid var(--line); background: var(--panel);
}
.brand { font-weight: 700; }
.tenant { color: var(--muted); font-size: 13px; font-family: ui-monospace, monospace; }
header.top nav { margin-left: auto; display: flex; gap: 14px; align-items: center; }
a { color: var(--accent); }
main { max-width: 1000px; margin: 0 auto; padding: 24px 20px 64px; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 28px 0 8px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
p.lead { color: var(--muted); margin: 0 0 24px; }
form.inline { display: inline; }
fieldset { border: 1px solid var(--line); border-radius: 6px; padding: 16px; margin: 0 0 20px; background: var(--panel); }
legend { font-weight: 600; padding: 0 6px; }
label { display: block; margin: 0 0 14px; }
label > span { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
input[type=text], input[type=password], input[type=number], select, textarea {
  width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 4px;
  background: var(--bg); color: var(--fg); font: inherit;
}
textarea { font-family: ui-monospace, monospace; font-size: 12px; }
button {
  font: inherit; font-weight: 600; padding: 8px 16px; border-radius: 4px; cursor: pointer;
  border: 1px solid var(--accent); background: var(--accent); color: #fff;
}
button.secondary { background: transparent; color: var(--accent); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
td.k { width: 34%; color: var(--muted); }
code, .mono { font-family: ui-monospace, monospace; font-size: 12.5px; }
.notice { padding: 10px 14px; border-radius: 4px; border-left: 4px solid; margin: 0 0 18px; }
.notice.error { border-color: var(--error); background: color-mix(in srgb, var(--error) 10%, transparent); }
.notice.warn { border-color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.notice.info { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.status { font-weight: 700; }
.status.VERIFIED, .status.ISSUED { color: var(--ok); }
.status.FAILED, .status.EXPIRED, .status.DECLINED_BY_USER { color: var(--error); }
figure.qr { margin: 0; text-align: center; }
.qr-svg svg { width: 260px; height: 260px; background: #fff; padding: 8px; border-radius: 4px; }
figcaption { font-size: 12px; color: var(--muted); margin: 6px 0 10px; }
.qr-value { font-size: 11px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
@media (max-width: 760px) { .two { grid-template-columns: 1fr; } }
footer { border-top: 1px solid var(--line); padding: 16px 20px; color: var(--muted); font-size: 12px; }
footer p { max-width: 1000px; margin: 0 auto; }
.record { font-family: ui-monospace, monospace; font-size: 12px; white-space: pre; }
`;
