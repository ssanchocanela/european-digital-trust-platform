import { html, type SafeHtml } from "./html.js";
import type {
  AuditEvent,
  IntendedUseOption,
  ProviderAuthentication,
  ServiceOption,
} from "./platform-client.js";

/**
 * The screens that show what this tenant *is*, rather than what it is doing.
 *
 * Services and what they registered, the certificates each holds, the audit trail of one
 * presentation, and the tenant itself. Together with the two operating screens they complete the
 * eight this console was planned around — `docs/web-interface-proposal.md` §4.
 *
 * ## These are read-only, and that is a decision
 *
 * A Relying Party Service and its intended use record an **authorisation**: what a Registrar allowed
 * this party to ask for. Creating one from a console would make it look like an ordinary
 * configuration form, and the registration it stands for would be the one thing the screen does not
 * do. The registration screen exists for the real chain; these show its result.
 *
 * Tenants are read-only for a different reason: creating one needs the platform's **admin**
 * credential, and this console deliberately holds only a tenant key. A console that held an admin
 * key could create tenants, and a compromise of it would be a different and much larger event.
 */

const when = (iso?: string): string => (iso ? iso.slice(0, 19).replace("T", " ") : "—");

const claimPathLabel = (path: readonly (string | number | null)[]): string =>
  path
    .map((p) => (p === null ? "[]" : typeof p === "number" ? `[${p}]` : `.${p}`))
    .join("")
    .replace(/^\./, "");

// --- Services, their registrations, and the certificates each holds -----------------------------

export const servicesView = (options: {
  readonly services: readonly (ServiceOption & {
    readonly intendedUses: readonly IntendedUseOption[];
    readonly instance?: { readonly provisioned: boolean; readonly trustEnvironment?: string };
  })[];
  readonly error?: string;
}): SafeHtml => html`
  <h1>Relying Party Services</h1>
  <p class="lead">
    What this tenant is authorised to ask for, and what it holds to ask with. A Service's
    <strong>intended use</strong> records the credentials and attributes a Registrar allowed it to
    request — every offer is validated against it, so this is the bound on everything the verification
    side can do.
  </p>
  ${options.error ? html`<p class="notice error">${options.error}</p>` : ""}

  ${
    options.services.length === 0
      ? html`<p class="empty">No Services. Use the registration screen to create the real chain.</p>`
      : options.services.map(
          (service) => html`
            <section class="panel">
              <h2>${service.name}</h2>
              <p class="dim"><code>${service.serviceIdentifier}</code></p>

              <table class="gate">
                <tr>
                  <td>Access certificate</td>
                  <td>${
                    service.instance?.provisioned
                      ? html`<span class="chip chip-ok">imported</span>`
                      : html`<span class="chip chip-bad">none</span>`
                  }</td>
                  <td class="dim">
                    ${
                      service.instance?.provisioned
                        ? html`The instance holds one. Whether a wallet <em>trusts</em> it is a
                          different question: a Wallet Unit accepts only anchors from lists notified
                          by Member States (blocker B1).`
                        : html`Without one this Service cannot sign a presentation request, so no
                          wallet will accept anything it sends.`
                    }
                  </td>
                </tr>
                ${
                  service.instance?.trustEnvironment
                    ? html`<tr>
                        <td>Trust environment</td>
                        <td><code>${service.instance.trustEnvironment}</code></td>
                        <td class="dim">V0 supports <code>TEST</code> only.</td>
                      </tr>`
                    : ""
                }
              </table>

              ${
                service.intendedUses.length === 0
                  ? html`<p class="empty">
                      No intended use, so this Service has registered nothing and can ask for nothing.
                    </p>`
                  : service.intendedUses.map(
                      (use) => html`
                        <h3>Registered under <code>${use.identifier}</code></h3>
                        ${use.registeredCredentials.map(
                          (credential) => html`
                            <div class="credential">
                              <p>
                                <strong>${
                                  credential.vctValues?.[0] ??
                                  credential.doctype ??
                                  credential.format
                                }</strong>
                                <code class="format">${credential.format}</code>
                              </p>
                              <div class="claims">
                                ${credential.claims.map(
                                  (path) => html`<code>${claimPathLabel(path)}</code>`,
                                )}
                              </div>
                            </div>
                          `,
                        )}
                      `,
                    )
              }
            </section>
          `,
        )
  }
`;

// --- The audit trail of one presentation --------------------------------------------------------

export const auditView = (options: {
  readonly presentationId: string;
  readonly events: readonly AuditEvent[];
  readonly error?: string;
}): SafeHtml => html`
  <p class="crumb"><a href="/presentations/${options.presentationId}">Presentation</a></p>
  <h1>Audit trail</h1>
  <p class="lead">
    Every recorded step of this presentation. <strong>Evidence, never content</strong> — no disclosed
    attribute, no token, no credential appears here, and none ever will: the audit record is one of
    the five data classes kept separate in storage, and content has no table at all.
  </p>
  ${options.error ? html`<p class="notice error">${options.error}</p>` : ""}

  ${
    options.events.length === 0
      ? html`<p class="empty">No recorded events.</p>`
      : html`
        <table class="presentations">
          <thead>
            <tr><th>When</th><th>Action</th><th>Outcome</th><th>Actor</th><th>Detail</th></tr>
          </thead>
          <tbody>
            ${options.events.map(
              (event) => html`
                <tr>
                  <td class="dim">${when(event.at)}</td>
                  <td><code>${event.action}</code></td>
                  <td class="dim">${event.outcome ?? "—"}</td>
                  <td class="dim">${event.actor ?? "—"}</td>
                  <td class="dim">${renderDetail(event.detail)}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      `
  }
`;

/**
 * The detail bag, rendered as key/value pairs.
 *
 * Whatever the API put there and nothing else — the console has no privileged view and adds no
 * interpretation. Values are escaped like everything else, because an audit detail can carry a
 * business reference a customer chose.
 */
const renderDetail = (detail?: Readonly<Record<string, unknown>>): SafeHtml => {
  if (!detail) return html`—`;
  const entries = Object.entries(detail);
  if (entries.length === 0) return html`—`;
  return html`${entries.map(
    ([key, value]) => html`<span class="kv"><code>${key}</code> ${String(value)}</span> `,
  )}`;
};

// --- This tenant --------------------------------------------------------------------------------

export const tenantView = (options: {
  readonly tenantId: string;
  readonly services: number;
  readonly presentationPolicies: number;
  readonly issuancePolicies: number;
  readonly providers: number;
  readonly gate?: ProviderAuthentication;
  readonly platform: string;
  readonly engine: string;
  readonly error?: string;
}): SafeHtml => html`
  <h1>This tenant</h1>
  <p class="lead">
    The console holds one tenant credential and can see exactly what that credential can. It has no
    privileged view — <code>docs/web-interface-proposal.md</code> §3.1.
  </p>
  ${options.error ? html`<p class="notice error">${options.error}</p>` : ""}

  <table class="gate">
    <tr><td>Tenant</td><td><code>${options.tenantId}</code></td><td class="dim"></td></tr>
    <tr>
      <td>Relying Party Services</td>
      <td>${String(options.services)}</td>
      <td class="dim"><a href="/services">See what each registered</a></td>
    </tr>
    <tr>
      <td>Verification offers</td>
      <td>${String(options.presentationPolicies)}</td>
      <td class="dim"><a href="/offers">Open</a></td>
    </tr>
    <tr>
      <td>Issuance policies</td>
      <td>${String(options.issuancePolicies)}</td>
      <td class="dim"><a href="/issuance">Open</a></td>
    </tr>
    <tr>
      <td>Attestation Providers</td>
      <td>${String(options.providers)}</td>
      <td class="dim">
        ${
          options.gate?.walletCanAuthenticateProvider === true
            ? "A wallet can authenticate the issuer."
            : "A wallet cannot authenticate the issuer, so nothing can be collected."
        }
      </td>
    </tr>
    <tr>
      <td>Platform</td>
      <td><code>${options.platform}</code></td>
      <td class="dim">Engine <code>${options.engine}</code></td>
    </tr>
  </table>

  <h2>Creating a tenant is not here, deliberately</h2>
  <p class="sub">
    It needs the platform's <strong>admin</strong> credential, and this console holds only a tenant
    key. A console that could create tenants would be a much larger thing to compromise, and the
    operation is rare enough to belong at the API. The key a new tenant gets is shown once and stored
    only as a hash, so there is nothing here that could show it again either.
  </p>
`;
