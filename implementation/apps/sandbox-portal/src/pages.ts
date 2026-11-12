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
input,select,textarea{width:100%;padding:.55rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
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
<p><a href="/wallet">Get the sandbox wallet build</a></p>
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
export function walletStep(
  walletUri: string,
  interaction: "SAME_DEVICE" | "QR",
  options: { waitUrl?: string; about?: string } = {},
): string {
  const waitUrl = options.waitUrl ?? "/sign-in/wait";
  const about =
    options.about ?? "Your wallet will ask you to present your PID to the EDTP Sandbox.";
  if (interaction === "QR") {
    return page(
      "Scan with your wallet",
      `<h1>Scan with your wallet</h1>
<div class="qr">${qrSvg(walletUri)}</div>
<p>${escapeHtml(about)}</p>
<p class="muted">This page checks every few seconds. Only this browser sees the outcome.</p>
<p><a class="button" href="${escapeHtml(waitUrl)}">I have presented</a></p>`,
      { refreshSeconds: 3 },
    ).replace(
      '<meta http-equiv="refresh" content="3">',
      `<meta http-equiv="refresh" content="3;url=${escapeHtml(waitUrl)}">`,
    );
  }
  return page(
    "Open your wallet",
    `<h1>Open your wallet</h1><p>${escapeHtml(about)}</p>
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
  sections = "",
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
${sections}
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

// --- services and certificates (S3) ------------------------------------------------------------

export interface VariantOption {
  readonly id: string;
  readonly title: string;
  readonly requirement: string;
  readonly issuanceSide?: boolean;
}

export interface ServiceSummary {
  readonly relyingPartyServiceId: string;
  readonly serviceIdentifier: string;
  readonly serviceTradeName: string;
  readonly role: string;
}

export function servicesSection(orgId: string, services: readonly ServiceSummary[]): string {
  const id = escapeHtml(orgId);
  const rows = services
    .map(
      (s) =>
        `<tr><td><a href="/org/${id}/services/${escapeHtml(s.relyingPartyServiceId)}">${escapeHtml(s.serviceIdentifier)}</a></td><td>${escapeHtml(s.serviceTradeName)}</td><td>${s.role === "pid_provider" ? "PID Provider" : "Relying Party"}</td></tr>`,
    )
    .join("");
  return `<h2>Services</h2>
${services.length ? `<table><tr><th>Id</th><th>Name</th><th>Role</th></tr>${rows}</table>` : "<p>None yet.</p>"}
<form method="post" action="/org/${id}/services">
<label for="role">Role</label><select id="role" name="role"><option value="service_provider">Relying Party (Service_Provider)</option><option value="pid_provider">PID Provider (PID_Provider)</option></select>
<label for="tradeName">Service trade name</label><input id="tradeName" name="tradeName" required maxlength="200">
<label for="description">Description (English)</label><input id="description" name="description" required maxlength="500">
<label for="supportUri">Support address (https:// or mailto:)</label><input id="supportUri" name="supportUri" required maxlength="500">
<label for="privacyPolicyUri">Privacy policy (https://)</label><input id="privacyPolicyUri" name="privacyPolicyUri" required maxlength="500">
<label for="infoUri">Information page (https://)</label><input id="infoUri" name="infoUri" required maxlength="500">
<button>Register the service</button></form>`;
}

export interface CertificateSummary {
  readonly id: string;
  readonly kind: string;
  readonly variant: string;
  readonly variantTitle: string;
  readonly requirement: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
  readonly intendedUseId?: string;
  readonly walletCoreReason?: string;
  readonly issuanceSide?: boolean;
  readonly fingerprintSha256?: string;
  readonly notAfter?: string;
  readonly body?: string;
  readonly selfTest?: { fails: string[]; asDesigned: boolean; bindingNotChecked?: boolean };
}

const options = (variants: readonly VariantOption[]) =>
  variants
    .map(
      (v) =>
        `<option value="${escapeHtml(v.id)}">${escapeHtml(`${v.id} — ${v.title}${v.issuanceSide ? " (checked at issuance only)" : ""}`)}</option>`,
    )
    .join("");

export function servicePage(input: {
  readonly orgId: string;
  readonly service: ServiceSummary & {
    readonly intendedUses: readonly {
      id: string;
      intendedUseIdentifier: string;
      purpose: readonly { lang: string; value: string }[];
    }[];
  };
  readonly certificates: readonly CertificateSummary[];
  readonly wrpacVariants: readonly VariantOption[];
  readonly wrprcVariants: readonly VariantOption[];
  readonly error?: string;
  /** The hosted verifier section, when the platform offers one (S4). */
  readonly verifierHtml?: string;
}): string {
  const org = escapeHtml(input.orgId);
  const svc = escapeHtml(input.service.relyingPartyServiceId);
  const provider = input.service.role === "pid_provider";
  const uses = input.service.intendedUses
    .map(
      (u) =>
        `<tr><td><code>${escapeHtml(u.intendedUseIdentifier)}</code></td><td>${escapeHtml(u.purpose[0]?.value ?? "")}</td></tr>`,
    )
    .join("");
  const certs = input.certificates
    .map(
      (c) =>
        `<tr><td><a href="/org/${org}/certificates/${escapeHtml(c.id)}">${escapeHtml(c.kind)} ${escapeHtml(c.variant)}</a></td><td>${escapeHtml(c.variantTitle)}</td><td>${c.revokedAt ? "revoked" : "issued"}</td></tr>`,
    )
    .join("");
  return page(
    "Service",
    `<h1>${escapeHtml(input.service.serviceTradeName)} <code>${escapeHtml(input.service.serviceIdentifier)}</code></h1>
<p>${provider ? "PID Provider: entitlement PID_Provider, provides <code>urn:eudi:pid:1</code> in SD-JWT VC." : "Relying Party: entitlement Service_Provider."}</p>
${input.error ? `<p role="alert"><strong>${escapeHtml(input.error)}</strong></p>` : ""}
${
  provider
    ? '<p class="muted">A PID Provider has no intended use (RPRC_05).</p>'
    : `<h2>Intended uses</h2>${uses ? `<table><tr><th>Id</th><th>Purpose</th></tr>${uses}</table>` : "<p>None yet. A registration certificate is issued per intended use.</p>"}
<form method="post" action="/org/${org}/services/${svc}/intended-uses">
<label for="purpose">Purpose (English)</label><input id="purpose" name="purpose" required maxlength="500">
<label for="claims">PID claims it may request, one claim path per line (dots between elements; <code>*</code> for any array element)</label>
<textarea id="claims" name="claims" rows="5" required>given_name
family_name
birthdate</textarea>
<button>Register the intended use</button></form>`
}
${input.verifierHtml ?? ""}
<h2>Certificates</h2>
${certs ? `<table><tr><th>Certificate</th><th>Variant</th><th>State</th></tr>${certs}</table>` : "<p>None yet.</p>"}
<h3>Access certificate (take-away)</h3>
<p class="muted">Issued against your certification request: your private key never reaches the sandbox. P-256 only.
<code>openssl ecparam -name prime256v1 -genkey -noout -out key.pem &amp;&amp; openssl req -new -key key.pem -subj /CN=x -out req.pem</code>.
The subject is taken from the sandbox register, not from the request.</p>
<form method="post" action="/org/${org}/services/${svc}/access-certificates">
<label for="ac-variant">Variant</label><select id="ac-variant" name="variant">${options(input.wrpacVariants)}</select>
<label for="dnsNames">DNS names your verifier serves from, one per line</label><textarea id="dnsNames" name="dnsNames" rows="2" required></textarea>
<label for="csrPem">Certification request (PEM)</label><textarea id="csrPem" name="csrPem" rows="8" required></textarea>
<button>Issue the access certificate</button></form>
<h3>Registration certificate</h3>
<form method="post" action="/org/${org}/services/${svc}/registration-certificates">
<label for="rc-variant">Variant</label><select id="rc-variant" name="variant">${options(input.wrprcVariants)}</select>
${
  provider
    ? ""
    : `<label for="intendedUseId">Intended use</label><select id="intendedUseId" name="intendedUseId">${input.service.intendedUses
        .map(
          (u) =>
            `<option value="${escapeHtml(u.id)}">${escapeHtml(u.intendedUseIdentifier)}</option>`,
        )
        .join("")}</select>`
}
<button>Issue the registration certificate</button></form>
<p><a href="/org/${org}">Back to the organisation</a></p>`,
    { signedIn: true },
  );
}

export function certificatePage(orgId: string, cert: CertificateSummary): string {
  const org = escapeHtml(orgId);
  const id = escapeHtml(cert.id);
  const test = cert.selfTest;
  return page(
    "Certificate",
    `<h1>${escapeHtml(cert.kind)} <code>${escapeHtml(cert.variant)}</code> — ${escapeHtml(cert.variantTitle)}</h1>
<table>
<tr><th>Built to test</th><td>${escapeHtml(cert.requirement)}</td></tr>
${cert.walletCoreReason ? `<tr><th>Wallet Core 0.30.2 reason</th><td><code>${escapeHtml(cert.walletCoreReason)}</code> (what a debug build logs)</td></tr>` : ""}
<tr><th>Issued</th><td>${escapeHtml(cert.createdAt)}</td></tr>
${cert.notAfter ? `<tr><th>Not after</th><td>${escapeHtml(cert.notAfter)}</td></tr>` : ""}
${cert.fingerprintSha256 ? `<tr><th>SHA-256</th><td><code>${escapeHtml(cert.fingerprintSha256)}</code></td></tr>` : ""}
<tr><th>State</th><td>${cert.revokedAt ? `revoked ${escapeHtml(cert.revokedAt)} — final` : "issued"}</td></tr>
${
  test
    ? `<tr><th>The sandbox's own check</th><td>${test.fails.length ? `fails <code>${escapeHtml(test.fails.join(", "))}</code>` : "passes every check"}${test.asDesigned ? " — as designed" : " — <strong>not as designed</strong>"}${test.bindingNotChecked ? "; binding not checked: no correct access certificate for this service yet" : ""}</td></tr>`
    : ""
}
</table>
<p class="muted">The sandbox's own check is not a wallet's verdict. What a wallet does with this certificate is
what you record in a run report, together with the wallet build and the position of
<em>Check Registration Certificates</em>.</p>
${cert.issuanceSide ? "<p><strong>Checked at issuance only.</strong> A wallet looks at it before requesting a PID, and only when the issuer's metadata is signed and the wallet build does not carry WD-2: use the <code>sandbox-strict</code> wallet build. With the ordinary sandbox build it is not exercised.</p>" : ""}
${cert.body ? `<p><a class="button" href="/org/${org}/certificates/${id}/download">Download</a></p>` : "<p>RC-01 is the absence of a registration certificate: there is nothing to download.</p>"}
${cert.revokedAt ? "" : `<form method="post" action="/org/${org}/certificates/${id}/revoke"><button class="secondary">Revoke (final)</button></form>`}
<p><a href="/org/${org}">Back to the organisation</a></p>`,
    { signedIn: true },
  );
}

/** One claim path per line: dots between elements, `*` for any array element, digits for an index. */
export function parseClaimLines(text: string): (string | number | null)[][] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .split(".")
        .map((part) => (part === "*" ? null : /^\d+$/.test(part) ? Number(part) : part)),
    );
}

// --- the hosted verifier and runs (S4) ---------------------------------------------------------

export interface VerifierView {
  readonly configured: boolean;
  readonly accessCertificate?: CertificateSummary;
  readonly uses?: readonly {
    intendedUseId: string;
    registrationCertificate: CertificateSummary;
  }[];
}

export function verifierSection(input: {
  readonly orgId: string;
  readonly serviceId: string;
  readonly intendedUses: readonly { id: string; intendedUseIdentifier: string }[];
  readonly verifier: VerifierView;
  readonly wrpacVariants: readonly VariantOption[];
  readonly wrprcVariants: readonly VariantOption[];
}): string {
  const org = escapeHtml(input.orgId);
  const svc = escapeHtml(input.serviceId);
  if (input.intendedUses.length === 0) {
    return "<h2>Hosted verifier</h2><p>Register an intended use first.</p>";
  }
  const current = input.verifier.configured
    ? `<p>Presents now: access certificate <a href="/org/${org}/certificates/${escapeHtml(input.verifier.accessCertificate?.id ?? "")}"><code>${escapeHtml(input.verifier.accessCertificate?.variant ?? "")}</code></a>${(
        input.verifier.uses ?? []
      )
        .map((u) => {
          const use = input.intendedUses.find((x) => x.id === u.intendedUseId);
          return `; for <code>${escapeHtml(use?.intendedUseIdentifier ?? "")}</code> registration certificate <a href="/org/${org}/certificates/${escapeHtml(u.registrationCertificate.id)}"><code>${escapeHtml(u.registrationCertificate.variant)}</code></a>`;
        })
        .join("")}.</p>`
    : "<p>Not configured yet. The first configuration creates its engine tenant.</p>";
  const variantSelect = (name: string, variants: readonly VariantOption[]) =>
    `<select name="${escapeHtml(name)}">${variants
      .filter((v) => !v.issuanceSide)
      .map(
        (v) =>
          `<option value="${escapeHtml(v.id)}">${escapeHtml(`${v.id} — ${v.title}`)}</option>`,
      )
      .join("")}</select>`;
  const configured = input.verifier.configured
    ? `<h3>Run a presentation</h3>
<form method="post" action="/org/${org}/services/${svc}/runs">
<label>Intended use<select name="intendedUseId">${input.intendedUses
        .map(
          (u) =>
            `<option value="${escapeHtml(u.id)}">${escapeHtml(u.intendedUseIdentifier)}</option>`,
        )
        .join("")}</select></label>
<label>Where is the wallet?<select name="interaction"><option value="SAME_DEVICE">On this device</option><option value="QR">On my phone (QR — a cross-device flow the ARF discourages)</option></select></label>
<button>Start a run</button></form>`
    : "";
  return `<h2>Hosted verifier</h2>
<p class="muted">A verifier the sandbox runs for this service, presenting the certificates you choose. Each
configuration issues fresh certificates and swaps them in for the next run.</p>
${current}
<form method="post" action="/org/${org}/services/${svc}/verifier">
<label>Access certificate variant ${variantSelect("accessVariant", input.wrpacVariants)}</label>
${input.intendedUses
  .map(
    (u) =>
      `<label>Registration certificate for <code>${escapeHtml(u.intendedUseIdentifier)}</code> ${variantSelect(`rc_${u.id}`, input.wrprcVariants)}</label>`,
  )
  .join("")}
<button>${input.verifier.configured ? "Reconfigure" : "Configure"} the hosted verifier</button></form>
${configured}`;
}

export const OBSERVATIONS: readonly [string, string][] = [
  ["refused_before_consent", "The wallet refused before asking me anything"],
  ["warned_user_stopped", "The wallet warned me, and I stopped"],
  ["warned_user_continued", "The wallet warned me, and I continued"],
  ["presented_without_warning", "The wallet asked for consent without any warning"],
  ["error_shown", "The wallet showed an error"],
  ["nothing_happened", "Nothing happened"],
  ["other", "Something else (say what in the note)"],
];

export interface RunReport {
  readonly id: string;
  readonly createdAt: string;
  readonly interaction: string;
  readonly outcome: {
    readonly status: string;
    readonly failureCode?: string;
    readonly sentWithoutRegistrationCertificate?: boolean;
    readonly claimsPresent?: Record<string, unknown>;
  };
  readonly accessCertificate: CertificateSummary;
  readonly registrationCertificate: CertificateSummary;
  readonly expected: {
    readonly access: { variant: string; requirement: string };
    readonly registration: { variant: string; requirement: string; registrationCheck: boolean };
  };
  readonly observation: {
    readonly walletBuild?: string;
    readonly checkRegistrationCertificates?: string;
    readonly observation?: string;
    readonly note?: string;
    readonly observedAt?: string;
  };
}

const TERMINAL = new Set([
  "VERIFIED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "POLICY_NOT_SATISFIED",
  "PROTOCOL_ERROR",
  "DECLINED_BY_USER",
]);

export function runPage(orgId: string, report: RunReport): string {
  const org = escapeHtml(orgId);
  const o = report.observation;
  const settled = TERMINAL.has(report.outcome.status);
  const observed = Boolean(o.observedAt);
  return page(
    "Run report",
    `<h1>Run report</h1>
<table>
<tr><th>Started</th><td>${escapeHtml(report.createdAt)} — ${escapeHtml(report.interaction)}</td></tr>
<tr><th>Access certificate</th><td><a href="/org/${org}/certificates/${escapeHtml(report.accessCertificate.id)}"><code>${escapeHtml(report.expected.access.variant)}</code></a> ${escapeHtml(report.accessCertificate.variantTitle)} — ${escapeHtml(report.expected.access.requirement)}</td></tr>
<tr><th>Registration certificate</th><td><a href="/org/${org}/certificates/${escapeHtml(report.registrationCertificate.id)}"><code>${escapeHtml(report.expected.registration.variant)}</code></a> ${escapeHtml(report.registrationCertificate.variantTitle)} — ${escapeHtml(report.expected.registration.requirement)}${report.expected.registration.registrationCheck ? " <em>(a wallet looks at it only with <strong>Check Registration Certificates</strong> on)</em>" : ""}</td></tr>
<tr><th>The platform's outcome</th><td><code>${escapeHtml(report.outcome.status)}</code>${report.outcome.failureCode ? ` — <code>${escapeHtml(report.outcome.failureCode)}</code>` : ""}${report.outcome.sentWithoutRegistrationCertificate ? "; sent without a registration certificate" : ""}${settled ? "" : " — not settled yet; this page refreshes"}</td></tr>
${
  report.outcome.claimsPresent
    ? `<tr><th>Claims present</th><td>${escapeHtml(
        Object.keys(report.outcome.claimsPresent)
          .map((k) => k.replace(/^present_/, ""))
          .join(", "),
      )} (presence only — no value is kept)</td></tr>`
    : ""
}
</table>
<h2>What the wallet did</h2>
<p class="muted">Only you can say: the sandbox sees the protocol, not the wallet's screen. Record the build and the
position of <em>Check Registration Certificates</em> — without them the observation cannot be read.
<strong>No credential value belongs in the note.</strong></p>
${
  observed
    ? `<table><tr><th>Wallet build</th><td>${escapeHtml(o.walletBuild ?? "")}</td></tr><tr><th>Check Registration Certificates</th><td>${escapeHtml(o.checkRegistrationCertificates ?? "")}</td></tr><tr><th>Observation</th><td>${escapeHtml(OBSERVATIONS.find(([k]) => k === o.observation)?.[1] ?? o.observation ?? "")}</td></tr>${o.note ? `<tr><th>Note</th><td>${escapeHtml(o.note)}</td></tr>` : ""}</table>`
    : `<form method="post" action="/org/${org}/runs/${escapeHtml(report.id)}/observation">
<label for="walletBuild">Wallet build (e.g. "EDTP sandbox wallet S1, modified")</label><input id="walletBuild" name="walletBuild" required maxlength="100">
<label>Check Registration Certificates<select name="checkRegistrationCertificates"><option value="off">off</option><option value="on">on</option><option value="unknown">I do not know</option></select></label>
<label>What happened<select name="observation">${OBSERVATIONS.map(([k, v]) => `<option value="${escapeHtml(k)}">${escapeHtml(v)}</option>`).join("")}</select></label>
<label for="note">Note (optional, 500 characters, no credential values)</label><input id="note" name="note" maxlength="500">
<button>Record the observation</button></form>`
}
<p><a href="/org/${org}">Back to the organisation</a></p>`,
    { signedIn: true, ...(settled ? {} : { refreshSeconds: 3 }) },
  );
}

export function runsSection(
  orgId: string,
  runs: readonly { id: string; createdAt: string; interaction: string; observed: boolean }[],
): string {
  if (runs.length === 0) return "";
  const org = escapeHtml(orgId);
  return `<h2>Runs</h2><table><tr><th>Started</th><th>Flow</th><th>Observed</th></tr>${runs
    .slice(0, 20)
    .map(
      (r) =>
        `<tr><td><a href="/org/${org}/runs/${escapeHtml(r.id)}">${escapeHtml(r.createdAt)}</a></td><td>${escapeHtml(r.interaction)}</td><td>${r.observed ? "yes" : "not yet"}</td></tr>`,
    )
    .join("")}</table>`;
}

// --- the hosted PID issuer (S5) ----------------------------------------------------------------

export interface IssuerView {
  readonly configured: boolean;
  readonly signingCertificate?: {
    id: string;
    variant: string;
    variantTitle: string;
    requirement: string;
    notAfter?: string;
  };
  readonly registrationCertificate?: CertificateSummary;
  readonly issuances?: readonly { id: string; createdAt: string; revokedAt?: string }[];
}

export function issuerSection(input: {
  readonly orgId: string;
  readonly serviceId: string;
  readonly issuer: IssuerView;
  readonly signingVariants: readonly VariantOption[];
  readonly wrprcVariants: readonly VariantOption[];
  /** The access certificate variants: the certificate that signs the issuer's metadata (S5b). */
  readonly accessVariants?: readonly VariantOption[];
}): string {
  const org = escapeHtml(input.orgId);
  const svc = escapeHtml(input.serviceId);
  const select = (name: string, variants: readonly VariantOption[]) =>
    `<select name="${escapeHtml(name)}">${variants
      .map(
        (v) =>
          `<option value="${escapeHtml(v.id)}">${escapeHtml(`${v.id} — ${v.title}${v.issuanceSide ? " (checked at issuance only)" : ""}`)}</option>`,
      )
      .join("")}</select>`;
  const i = input.issuer;
  const current = i.configured
    ? `<p>Signs now with <code>${escapeHtml(i.signingCertificate?.variant ?? "")}</code> ${escapeHtml(i.signingCertificate?.variantTitle ?? "")}; publishes registration certificate <a href="/org/${org}/certificates/${escapeHtml(i.registrationCertificate?.id ?? "")}"><code>${escapeHtml(i.registrationCertificate?.variant ?? "")}</code></a> as its issuer information.</p>`
    : "<p>Not configured yet. The first configuration creates its engine tenant and its PID credential type.</p>";
  const issuances = (i.issuances ?? [])
    .slice(0, 20)
    .map(
      (x) =>
        `<tr><td><a href="/org/${org}/issuances/${escapeHtml(x.id)}">${escapeHtml(x.createdAt)}</a></td><td>${x.revokedAt ? "revoked" : ""}</td></tr>`,
    )
    .join("");
  const offerForm = i.configured
    ? `<h3>Issue a synthetic PID</h3>
<p><strong>Synthetic data only.</strong> The sandbox cannot tell a real name from an invented one, so it
relies on you: type values that belong to nobody. They are passed to the issuer and kept nowhere by the
platform; the engine holds them for its session window only.</p>
<form method="post" action="/org/${org}/services/${svc}/issuer/offers">
<label for="givenName">Given name</label><input id="givenName" name="givenName" required maxlength="100">
<label for="familyName">Family name</label><input id="familyName" name="familyName" required maxlength="100">
<label for="birthdate">Date of birth</label><input id="birthdate" name="birthdate" type="date" required>
<label for="birthCountry">Country of birth (ISO 3166-1 alpha-2)</label><input id="birthCountry" name="birthCountry" required pattern="[A-Z]{2}" maxlength="2">
<label for="nationalities">Nationalities (alpha-2, separated by spaces)</label><input id="nationalities" name="nationalities" required maxlength="20">
<label>Where is the wallet?<select name="interaction"><option value="SAME_DEVICE">On this device (a link)</option><option value="QR">On my phone (a QR code)</option></select></label>
<button>Offer the PID</button></form>
${issuances ? `<h3>Issued</h3><table><tr><th>Offered</th><th></th></tr>${issuances}</table>` : ""}`
    : "";
  return `<h2>Hosted PID issuer</h2>
<p class="muted">An issuer the sandbox runs for this service, signing PIDs with a certificate the sandbox PID
CA issues — correct or defective. The sandbox signs this issuer's metadata with its access certificate
(ADR 0016), so a wallet can authenticate it before asking for a PID. The issuance-side registration checks
are exercised only by the <code>sandbox-strict</code> wallet build: the ordinary sandbox build carries WD-2,
which switches them off.</p>
${current}
<form method="post" action="/org/${org}/services/${svc}/issuer">
${input.accessVariants ? `<label>Access certificate variant (signs the metadata) ${select("accessVariant", input.accessVariants)}</label>` : ""}
<label>Signing certificate variant ${select("signingVariant", input.signingVariants)}</label>
<label>Registration certificate variant ${select("registrationVariant", input.wrprcVariants)}</label>
<button>${i.configured ? "Reconfigure" : "Configure"} the hosted issuer</button></form>
${offerForm}`;
}

export interface IssuanceStatusView {
  readonly id: string;
  readonly status: string;
  readonly failureCode?: string;
  readonly revocable: boolean;
  readonly revokedAt?: string;
  readonly signingCertificate: { variant: string; variantTitle: string; requirement: string };
}

const ISSUANCE_TERMINAL = new Set([
  "ISSUED",
  "DECLINED_BY_USER",
  "TRUST_ERROR",
  "PROTOCOL_ERROR",
  "EXPIRED",
  "CANCELLED",
  "NOT_ELIGIBLE",
  "FAILED",
]);

export function issuancePage(orgId: string, view: IssuanceStatusView): string {
  const org = escapeHtml(orgId);
  const settled = ISSUANCE_TERMINAL.has(view.status);
  return page(
    "Issuance",
    `<h1>Synthetic PID issuance</h1>
<table>
<tr><th>Signing certificate</th><td><code>${escapeHtml(view.signingCertificate.variant)}</code> ${escapeHtml(view.signingCertificate.variantTitle)} — ${escapeHtml(view.signingCertificate.requirement)}</td></tr>
<tr><th>The platform's outcome</th><td><code>${escapeHtml(view.status)}</code>${view.failureCode ? ` — <code>${escapeHtml(view.failureCode)}</code>` : ""}${settled ? "" : " — not settled yet; this page refreshes"}</td></tr>
${view.revokedAt ? `<tr><th>Revoked</th><td>${escapeHtml(view.revokedAt)} — final</td></tr>` : ""}
</table>
<p class="muted">A PID issued under PID-01 or PID-02 is issued all the same: whether the wallet accepts it,
and whether a verifier then does, is what the run tells you.</p>
${view.revocable ? `<form method="post" action="/org/${org}/issuances/${escapeHtml(view.id)}/revoke"><button class="secondary">Revoke this PID (PID-03, final)</button></form>` : ""}
<p><a href="/org/${org}">Back to the organisation</a></p>`,
    { signedIn: true, ...(settled ? {} : { refreshSeconds: 3 }) },
  );
}

/** The sandbox wallet build page (ADR 0017): behind Cloudflare Access, like the whole portal. */
export function walletPage(
  offer:
    | { readonly state: "none"; readonly reason: string }
    | {
        readonly state: "offered";
        readonly builds: readonly {
          readonly file: string;
          readonly sha256: string;
          readonly profile: string;
          readonly deviations: string;
          readonly builtAt: string;
          readonly notice: string;
        }[];
      },
): string {
  const terms = `<h2>What this is</h2>
<ul>
<li>A <strong>modified</strong> build of the EUDI Wallet Reference Implementation (Android), licensed under the
<strong>EUPL 1.2</strong>. It is not the Reference Wallet and not any Member State's wallet.</li>
<li>It trusts only this sandbox's test trust lists, and it carries the deviations listed with each build. Its
applicationId, signing key (<code>OU=TEST ONLY</code>) and the banner on every screen say so.</li>
<li>The source of the modifications is <a href="https://github.com/ssanchocanela/european-digital-trust-platform/tree/main/implementation/tools/test-wallet">tools/test-wallet</a>;
each build's notice names the upstream release, the modifications and the licence terms.</li>
<li>Test use with synthetic data only. Not on Google Play, and not to be redistributed as anything but what it is.</li>
</ul>`;
  if (offer.state === "none") {
    return page(
      "Sandbox wallet",
      `<h1>Sandbox wallet</h1><p>${escapeHtml(offer.reason)}</p>${terms}`,
    );
  }
  const rows = offer.builds
    .map(
      (b) => `<tr><td><a href="/wallet/${escapeHtml(b.file)}">${escapeHtml(b.file)}</a></td>
<td>${escapeHtml(b.profile)}</td><td><code>${escapeHtml(b.deviations)}</code></td><td>${escapeHtml(b.builtAt)}</td>
<td><code class="wrap">${escapeHtml(b.sha256)}</code></td><td><a href="/wallet/${escapeHtml(b.notice)}">notice</a></td></tr>`,
    )
    .join("");
  return page(
    "Sandbox wallet",
    `<h1>Sandbox wallet</h1>
<p>Install beside any other wallet: it has its own applicationId. <strong>sandbox-strict</strong> requires signed
issuer metadata and runs the issuer registration checks; <strong>sandbox</strong> does not (WD-2).</p>
<table><thead><tr><th>Build</th><th>Profile</th><th>Deviations</th><th>Built</th><th>SHA-256</th><th>Terms</th></tr></thead>
<tbody>${rows}</tbody></table>${terms}`,
  );
}
