import { escapeHtml, page } from "./pages.js";

/**
 * The operator's pages (ADR 0019). Read-only tables and three confirmed actions. Everything shown
 * came from the platform's admin routes, which answer only an operator; every value is escaped.
 */
const e = escapeHtml;
const day = (iso: string | null | undefined) =>
  iso ? e(iso.slice(0, 16).replace("T", " ")) : "—";

const NAV = `<nav class="admin"><a href="/admin">Overview</a><a href="/admin/organisations">Organisations</a>
<a href="/admin/people">People</a><a href="/admin/invitations">Invitations</a>
<a href="/admin/wallet-providers">Wallet Providers</a><a href="/admin/audit">Audit trail</a>
<a href="/">Back to the portal</a></nav>`;

const adminPage = (title: string, body: string) =>
  page(`Operator · ${title}`, `${NAV}<h1>${e(title)}</h1>${body}`, { signedIn: true });

const table = (head: readonly string[], rows: readonly string[]) =>
  rows.length
    ? `<div class="scroll"><table><tr>${head.map((h) => `<th>${e(h)}</th>`).join("")}</tr>${rows.join("")}</table></div>`
    : "<p>None.</p>";

export type Quotas = Record<string, number>;

export interface Overview {
  readonly activeOrganisations: number;
  readonly suspendedOrganisations: number;
  readonly people: number;
  readonly pendingInvitations: number;
  readonly certificates: number;
  readonly revokedCertificates: number;
  readonly runsLastDay: number;
  readonly offersLastDay: number;
}

export function adminOverview(o: Overview): string {
  const rows: [string, number][] = [
    ["Organisations, active", o.activeOrganisations],
    ["Organisations, suspended", o.suspendedOrganisations],
    ["People", o.people],
    ["Pending invitations", o.pendingInvitations],
    ["Certificates issued", o.certificates],
    ["Certificates revoked", o.revokedCertificates],
    ["Hosted-verifier runs, last 24 hours", o.runsLastDay],
    ["PID offers, last 24 hours", o.offersLastDay],
  ];
  return adminPage(
    "Overview",
    `${table(
      ["", "Count"],
      rows.map(([k, v]) => `<tr><td>${e(k)}</td><td>${e(v)}</td></tr>`),
    )}
<p class="muted">You see every participant's e-mail address here. Admitting someone is done in the Cloudflare
Access policy, not in the sandbox.</p>`,
  );
}

export interface OrganisationRow {
  readonly tenantId: string;
  readonly localIdentifier: string;
  readonly legalName: string;
  readonly country: string;
  readonly status: string;
  readonly createdAt: string;
  readonly members: number;
  readonly services: number;
  readonly verifiers: number;
  readonly issuers: number;
  readonly certificates: number;
  readonly declaredEuid?: string | null;
  readonly suspendedAt?: string | null;
}

const use = (used: number, limit: number | undefined) =>
  `${e(used)}${limit !== undefined ? ` / ${e(limit)}` : ""}`;

export function adminOrganisations(list: readonly OrganisationRow[], quotas: Quotas): string {
  return adminPage(
    "Organisations",
    table(
      [
        "Identifier",
        "Legal name",
        "Country",
        "Status",
        "Members",
        "Services",
        "Verifiers",
        "Issuers",
        "Certificates",
        "Created",
      ],
      list.map(
        (
          o,
        ) => `<tr><td><a href="/admin/organisations/${e(o.tenantId)}">${e(o.localIdentifier)}</a></td>
<td>${e(o.legalName)}</td><td>${e(o.country)}</td><td class="status-${e(o.status)}">${e(o.status)}</td>
<td>${e(o.members)}</td><td>${use(o.services, quotas.servicesPerOrganisation)}</td>
<td>${use(o.verifiers, quotas.hostedVerifiersPerOrganisation)}</td><td>${use(o.issuers, quotas.hostedIssuersPerOrganisation)}</td>
<td>${e(o.certificates)}</td><td>${day(o.createdAt)}</td></tr>`,
      ),
    ),
  );
}

export interface OrganisationDetail {
  readonly organisation: OrganisationRow;
  readonly members: readonly {
    personId: string;
    displayName: string;
    email: string;
    role: string;
  }[];
  readonly services: readonly {
    id: string;
    role: string;
    serviceIdentifier: string;
    serviceTradeName: string;
    hasVerifier: boolean;
    hasIssuer: boolean;
    certificatesLastDay: number;
    runsLastDay: number;
    offersLastDay: number;
  }[];
  readonly certificates: readonly {
    id: string;
    kind: string;
    variant: string;
    notAfter: string | null;
    createdAt: string;
    revokedAt: string | null;
  }[];
  readonly invitations: readonly InvitationRow[];
  readonly quotas: Quotas;
}

export function adminOrganisation(d: OrganisationDetail): string {
  const o = d.organisation;
  const q = d.quotas;
  return adminPage(
    `Organisation ${o.localIdentifier}`,
    `<p>${e(o.legalName)} · ${e(o.country)}${o.declaredEuid ? ` · declared EUID <code>${e(o.declaredEuid)}</code> (not checked)` : ""}
· <span class="status-${e(o.status)}">${e(o.status)}</span>${o.suspendedAt ? ` since ${day(o.suspendedAt)}` : ""}</p>
<h2>Members</h2>
${table(
  ["Name", "E-mail", "Role"],
  d.members.map(
    (m) => `<tr><td>${e(m.displayName)}</td><td>${e(m.email)}</td><td>${e(m.role)}</td></tr>`,
  ),
)}
<h2>Services</h2>
${table(
  ["Service", "Role", "Hosted", "Certificates, 24 h", "Runs, 24 h", "PID offers, 24 h"],
  d.services.map(
    (
      s,
    ) => `<tr><td>${e(s.serviceTradeName)} <code>${e(s.serviceIdentifier)}</code></td><td>${e(s.role)}</td>
<td>${[s.hasVerifier ? "verifier" : "", s.hasIssuer ? "issuer" : ""].filter(Boolean).join(", ") || "—"}</td>
<td>${use(s.certificatesLastDay, q.certificatesPerServicePerDay)}</td><td>${use(s.runsLastDay, q.runsPerServicePerDay)}</td>
<td>${use(s.offersLastDay, q.offersPerServicePerDay)}</td></tr>`,
  ),
)}
<h2>Certificates</h2>
${table(
  ["Kind", "Variant", "Issued", "Expires", "Revoked"],
  d.certificates.map(
    (
      c,
    ) => `<tr><td>${e(c.kind)}</td><td><code>${e(c.variant)}</code></td><td>${day(c.createdAt)}</td>
<td>${day(c.notAfter)}</td><td>${day(c.revokedAt)}</td></tr>`,
  ),
)}
<h2>Pending invitations</h2>
${invitationTable(d.invitations)}
<p><a href="/admin/audit?organisation=${e(o.tenantId)}">Its audit trail</a></p>
${
  o.status === "ACTIVE"
    ? `<h2>Suspend</h2><p>Revokes every certificate it holds and stops it creating anything more. Final in v1.</p>
<p><a class="button" href="/admin/organisations/${e(o.tenantId)}/suspend">Suspend this organisation…</a></p>`
    : ""
}`,
  );
}

export function adminSuspendConfirm(o: OrganisationRow, error?: string): string {
  return adminPage(
    `Suspend ${o.localIdentifier}?`,
    `<p><strong>${e(o.legalName)}</strong>. Every certificate it holds is revoked now, its CRLs and status lists
are republished, and nothing more can be created for it. There is no undo in v1.</p>
${error ? `<p role="alert"><strong>${e(error)}</strong></p>` : ""}
<form method="post" action="/admin/organisations/${e(o.tenantId)}/suspend">
<label for="reason">Reason (kept in the audit trail; no personal data)</label>
<input id="reason" name="reason" required minlength="3" maxlength="200">
<button>Suspend it</button></form>
<p><a href="/admin/organisations/${e(o.tenantId)}">Cancel</a></p>`,
  );
}

export interface PersonRow {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly lastSignInAt: string;
  readonly pidPresented: boolean;
  readonly organisations: readonly { identifier: string; role: string }[];
}

export function adminPeople(list: readonly PersonRow[]): string {
  return adminPage(
    "People",
    table(
      ["Name", "E-mail", "Organisations", "PID", "Created", "Last sign-in", ""],
      list.map(
        (p) => `<tr><td>${e(p.displayName)}</td><td>${e(p.email || "—")}</td>
<td>${p.organisations.map((o) => `${e(o.identifier)} (${e(o.role)})`).join("<br>") || "—"}</td>
<td>${p.pidPresented ? "presented" : "—"}</td><td>${day(p.createdAt)}</td><td>${day(p.lastSignInAt)}</td>
<td><form method="post" action="/admin/people/${e(p.id)}/end-sessions"><button class="secondary">End sessions</button></form></td></tr>`,
      ),
    ) +
      `<p class="muted">Ending sessions signs the person out of the sandbox now. To keep them out, also remove
their address from the Cloudflare Access policy.</p>`,
  );
}

export interface InvitationRow {
  readonly id: string;
  readonly organisation: string;
  readonly email: string | null;
  readonly role: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

const invitationTable = (list: readonly InvitationRow[]) =>
  table(
    ["Organisation", "Invited address", "Role", "Created", "Expires", ""],
    list.map(
      (
        i,
      ) => `<tr><td>${e(i.organisation)}</td><td>${e(i.email ?? "—")}</td><td>${e(i.role)}</td>
<td>${day(i.createdAt)}</td><td>${day(i.expiresAt)}</td>
<td><form method="post" action="/admin/invitations/${e(i.id)}/revoke"><button class="secondary">Revoke</button></form></td></tr>`,
    ),
  );

export function adminInvitations(list: readonly InvitationRow[]): string {
  return adminPage(
    "Pending invitations",
    `${invitationTable(list)}
<p class="muted">An invited address must also be admitted in the Cloudflare Access policy before it can reach the
portal.</p>`,
  );
}

export interface AuditRow {
  readonly at: string;
  readonly organisation: string | null;
  readonly actor: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly outcome: string | null;
}

export function adminAudit(list: readonly AuditRow[], filtered: boolean): string {
  return adminPage(
    "Audit trail",
    `<p class="muted">The latest 200 sandbox records${filtered ? " of one organisation" : ""}. Actions and ids only.</p>
${table(
  ["When", "Organisation", "Actor", "Action", "Subject"],
  list.map(
    (
      a,
    ) => `<tr><td>${day(a.at)}</td><td>${e(a.organisation ?? "—")}</td><td><code>${e(a.actor)}</code></td>
<td>${e(a.action)}${a.outcome ? ` (${e(a.outcome)})` : ""}</td><td>${e(a.subjectType)} <code>${e(a.subjectId ?? "")}</code></td></tr>`,
  ),
)}`,
  );
}

export interface AdminAnchorRow {
  readonly id: string;
  readonly organisation: string;
  readonly organisationStatus: string;
  readonly kind: "ca" | "signer";
  readonly fingerprint: string;
  readonly subject: string;
  readonly notAfter: string;
  readonly status: string;
  readonly reason?: string;
  readonly createdAt: string;
}

/** Wallet Provider anchors awaiting a decision, and the rest (ADR 0020 §3). */
export function adminWalletProviders(list: readonly AdminAnchorRow[]): string {
  const pending = list.filter((a) => a.status === "PENDING");
  const others = list.filter((a) => a.status !== "PENDING");
  const row = (a: AdminAnchorRow, actions: string) =>
    `<tr><td>${e(a.organisation)}${a.organisationStatus !== "ACTIVE" ? ` <span class="status-SUSPENDED">${e(a.organisationStatus)}</span>` : ""}</td>
<td>${e(a.subject)}<br><small><code>${e(a.fingerprint)}</code></small></td><td>${a.kind === "ca" ? "CA" : "signer"}</td>
<td>${day(a.notAfter)}</td><td>${e(a.status)}${a.reason ? `<br><small>${e(a.reason)}</small>` : ""}</td><td>${actions}</td></tr>`;
  const decide = (a: AdminAnchorRow) =>
    `<form method="post" action="/admin/wallet-providers/${e(a.id)}/approve"><button>Approve</button></form>
<form method="post" action="/admin/wallet-providers/${e(a.id)}/refuse"><input name="reason" required minlength="3" maxlength="200" placeholder="Reason, shown to the provider"><button class="secondary">Refuse</button></form>`;
  const head = ["Organisation", "Certificate", "Kind", "Expires", "Status", ""];
  return adminPage(
    "Wallet Providers",
    `<p class="muted">An approved anchor goes on the sandbox's Wallet Providers list, and every hosted PID issuer then
accepts wallets whose attestations chain to it. A trusted provider can also make the engine fetch a URL of its
choosing (<code>interop-findings.md</code> A37), so approve only providers you know.</p>
<h2>Waiting for a decision</h2>
${table(
  head,
  pending.map((a) => row(a, decide(a))),
)}
<h2>Decided</h2>
${table(
  head,
  others.map((a) => row(a, "")),
)}`,
  );
}
