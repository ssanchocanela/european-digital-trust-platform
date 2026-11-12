import qrcode from "qrcode-generator";

/**
 * The portal's pages: pure functions from data to HTML, so the escaping and the statements they make
 * can be tested without a server.
 *
 * Every page carries the sandbox's two standing statements (specification §2, §12): only a modified
 * wallet trusts it, and only synthetic data belongs in it. No page says or implies conformance.
 */

export const escapeHtml = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) =>
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

export const STYLE = `
:root{color-scheme:light dark;--fg:#1b1f24;--bg:#fff;--muted:#59636e;--line:#d0d7de;--accent:#0b5cad;--warn:#7a4d00;--warnbg:#fff4d6}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--line:#30363d;--accent:#58a6ff;--warn:#f2cc60;--warnbg:#2b2111}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 3rem}
.banner{background:var(--warnbg);color:var(--warn);padding:.6rem 1rem;font-size:.9rem;border-bottom:1px solid var(--line)}
h1{font-size:1.6rem;margin:.5rem 0 1rem}h2{font-size:1.15rem;margin:2rem 0 .5rem}
a{color:var(--accent)}p.muted,small{color:var(--muted)}
form{margin:1rem 0}label{display:block;margin:.75rem 0 .25rem;font-weight:600}
input,select{width:100%;padding:.55rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
button,.button{display:inline-block;padding:.6rem 1.1rem;border:0;border-radius:6px;background:var(--accent);color:#fff;font:inherit;cursor:pointer;text-decoration:none;margin:.5rem .5rem 0 0}
button.secondary{background:transparent;color:var(--accent);border:1px solid var(--line)}
table{width:100%;border-collapse:collapse;margin:.5rem 0}td,th{text-align:left;padding:.4rem;border-bottom:1px solid var(--line)}
code,.secret{font-family:ui-monospace,monospace;word-break:break-all}
.secret{display:block;padding:.75rem;border:1px dashed var(--line);border-radius:6px;margin:.5rem 0}
.qr{max-width:16rem}.qr svg{width:100%;height:auto;background:#fff}
`;

const BANNER =
  "EDTP EUDI ecosystem sandbox — TEST ONLY. Only the EDTP sandbox wallet build, a modified wallet, " +
  "trusts this sandbox. Use synthetic data only.";

export function page(
  title: string,
  body: string,
  options: { refreshSeconds?: number; signedIn?: boolean } = {},
) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${options.refreshSeconds ? `<meta http-equiv="refresh" content="${options.refreshSeconds}">` : ""}
<title>${escapeHtml(title)} · EDTP Sandbox</title><link rel="stylesheet" href="/style.css"></head>
<body><div class="banner" role="note">${escapeHtml(BANNER)}</div><main>${body}
${options.signedIn ? `<form method="post" action="/sign-out"><button class="secondary">Sign out</button></form>` : ""}
</main></body></html>`;
}

export function landing(): string {
  return page(
    "Welcome",
    `<h1>EUDI ecosystem sandbox</h1>
<p>Play a role of the EUDI Wallet ecosystem — a <strong>Relying Party</strong> or a <strong>PID Provider</strong> —
against real protocol flows, with access and registration certificates issued by this sandbox's own test
authorities, correct or deliberately defective.</p>
<h2>Before you start</h2>
<ul>
<li>The sandbox is a separate <strong>test</strong> trust domain. Its certificates and trust lists are trusted
only by the <strong>EDTP sandbox wallet build</strong>, a modified build of the EUDI Reference Implementation
wallet. An official wallet will refuse them, by design.</li>
<li>You sign up and sign in by presenting a <strong>PID</strong> from your wallet. Only a PID from the reference
PID Providers or from "PID (demo)" is accepted for that.</li>
<li>The sandbox keeps a pseudonymous identifier and the name you type — nothing else from your PID.</li>
<li>Your organisation is <strong>self-declared and not verified</strong>.</li>
<li>Use synthetic data only.</li>
</ul>
<form method="post" action="/sign-up/start">${interactionChoice()}<button>Sign up with your PID</button></form>
<form method="post" action="/sign-in/start">${interactionChoice()}<button class="secondary">Sign in with your PID</button></form>`,
  );
}

function interactionChoice(): string {
  return `<label>Where is your wallet?<select name="interaction">
<option value="SAME_DEVICE">On this device</option>
<option value="QR">On my phone (scan a QR code — a cross-device flow the ARF discourages)</option>
</select></label>`;
}

const qrSvg = (value: string): string => {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
};

/** After a sign-in starts: a wallet link, or a QR code with a page that polls by refreshing. */
export function walletStep(walletUri: string, interaction: "SAME_DEVICE" | "QR"): string {
  if (interaction === "QR") {
    return page(
      "Scan with your wallet",
      `<h1>Scan with your wallet</h1>
<div class="qr">${qrSvg(walletUri)}</div>
<p class="muted">This page checks every few seconds. Only this browser can complete the sign-in.</p>
<p><a class="button" href="/sign-in/wait">I have presented my PID</a></p>`,
      { refreshSeconds: 3 },
    ).replace(
      '<meta http-equiv="refresh" content="3">',
      '<meta http-equiv="refresh" content="3;url=/sign-in/wait">',
    );
  }
  return page(
    "Open your wallet",
    `<h1>Open your wallet</h1><p>Your wallet will ask you to present your PID to the EDTP Sandbox.</p>
<p><a class="button" href="${escapeHtml(walletUri)}">Open wallet</a></p>
<p class="muted">After presenting, your wallet returns you here.</p>`,
  );
}

export function waiting(): string {
  return page(
    "Waiting for your wallet",
    `<h1>Waiting for your wallet…</h1><p class="muted">This page checks every few seconds.</p>`,
    { refreshSeconds: 3 },
  );
}

export function message(title: string, text: string, status = "info"): string {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><p data-status="${escapeHtml(status)}">${escapeHtml(text)}</p>
<p><a href="/">Back to the start</a></p>`,
  );
}

export function profileForm(purpose: "sign_up" | "accept_invitation", error?: string): string {
  const organisation =
    purpose === "sign_up"
      ? `<h2>Your organisation</h2><p class="muted">Self-declared. The sandbox does not verify it, and no
certificate will carry a registration number you type: certificates carry a sandbox identifier
<code>SB:&lt;country&gt;-&lt;number&gt;</code>.</p>
<label for="legalName">Legal name</label><input id="legalName" name="legalName" required maxlength="200">
<label for="tradeName">Trade name</label><input id="tradeName" name="tradeName" required maxlength="200">
<label for="country">Country (ISO 3166-1 alpha-2)</label><input id="country" name="country" required pattern="[A-Z]{2}" maxlength="2">
<label for="declaredEuid">EUID, if it has one (optional, declared only)</label><input id="declaredEuid" name="declaredEuid" maxlength="100">
<label><input type="checkbox" name="isPublicSectorBody" value="yes"> It is a public sector body</label>`
      : "";
  return page(
    "Your profile",
    `<h1>${purpose === "sign_up" ? "Create your account" : "Join the organisation"}</h1>
${error ? `<p role="alert"><strong>${escapeHtml(error)}</strong></p>` : ""}
<p>Your PID was verified. The sandbox kept only a pseudonymous identifier derived from it.</p>
<form method="post" action="/sign-in/profile">
<label for="displayName">Your name, as others in the sandbox will see it</label>
<input id="displayName" name="displayName" required maxlength="80">
<p class="muted">Typed by you, not taken from your PID.</p>
${organisation}
<button>Continue</button></form>`,
  );
}

export interface DashboardOrganisation {
  readonly id: string;
  readonly role: string;
}

export function dashboard(
  displayName: string,
  organisations: readonly DashboardOrganisation[],
): string {
  const rows = organisations
    .map(
      (o) =>
        `<tr><td><a href="/org/${escapeHtml(o.id)}">${escapeHtml(o.id)}</a></td><td>${escapeHtml(o.role)}</td></tr>`,
    )
    .join("");
  return page(
    "Your organisations",
    `<h1>Hello, ${escapeHtml(displayName)}</h1>
<h2>Your organisations</h2>
${organisations.length ? `<table><tr><th>Organisation</th><th>Role</th></tr>${rows}</table>` : "<p>None yet.</p>"}
<p class="muted">Relying Party and PID Provider tools arrive in the next sandbox milestones.</p>`,
    { signedIn: true },
  );
}

export interface OrganisationView {
  readonly id: string;
  readonly role: string;
  readonly localIdentifier: string;
  readonly country: string;
  readonly declaredEuid?: string;
  readonly members: readonly { personId: string; displayName: string; role: string }[];
  readonly apiKeys?: readonly {
    id: string;
    keyPrefix: string;
    label: string;
    revokedAt?: string | null;
  }[];
}

export function organisationPage(
  view: OrganisationView,
  shown?: { label: string; value: string },
): string {
  const owner = view.role === "owner";
  const id = escapeHtml(view.id);
  const members = view.members
    .map(
      (m) =>
        `<tr><td>${escapeHtml(m.displayName)}</td><td>${escapeHtml(m.role)}</td><td>${
          owner
            ? `<form method="post" action="/org/${id}/members/${escapeHtml(m.personId)}/remove"><button class="secondary">Remove</button></form>`
            : ""
        }</td></tr>`,
    )
    .join("");
  const keys = (view.apiKeys ?? [])
    .map(
      (k) =>
        `<tr><td>${escapeHtml(k.label)}</td><td><code>${escapeHtml(k.keyPrefix)}…</code></td><td>${
          k.revokedAt
            ? "revoked"
            : `<form method="post" action="/org/${id}/api-keys/${escapeHtml(k.id)}/revoke"><button class="secondary">Revoke</button></form>`
        }</td></tr>`,
    )
    .join("");
  return page(
    "Organisation",
    `<h1>Organisation <code>${escapeHtml(view.localIdentifier)}</code></h1>
<p><strong>Not verified.</strong> Self-declared by its members. Country ${escapeHtml(view.country)}${
      view.declaredEuid
        ? `; declared EUID <code>${escapeHtml(view.declaredEuid)}</code> (not checked)`
        : ""
    }.</p>
${shown ? `<h2>${escapeHtml(shown.label)}</h2><p>Shown once. Copy it now: the sandbox keeps only a hash.</p><code class="secret">${escapeHtml(shown.value)}</code>` : ""}
<h2>Members</h2><table><tr><th>Name</th><th>Role</th><th></th></tr>${members}</table>
${
  owner
    ? `<form method="post" action="/org/${id}/invitations"><label>Invite someone as
<select name="role"><option value="member">member</option><option value="owner">owner</option></select></label>
<button>Create invitation link</button></form>
<h2>API keys</h2><p class="muted">For automating your tests against the platform API as this organisation.</p>
${keys ? `<table><tr><th>Label</th><th>Prefix</th><th></th></tr>${keys}</table>` : "<p>None.</p>"}
<form method="post" action="/org/${id}/api-keys"><label for="label">Label</label><input id="label" name="label" required maxlength="100"><button>Create API key</button></form>`
    : ""
}
<p><a href="/">Back</a></p>`,
    { signedIn: true },
  );
}

export function invitationLanding(token: string): string {
  return page(
    "Invitation",
    `<h1>You have been invited</h1><p>Present your PID to join the organisation. If you are new to the sandbox,
you will be asked for your name.</p>
<form method="post" action="/invite/${escapeHtml(token)}/start">${interactionChoice()}<button>Join with your PID</button></form>`,
  );
}
