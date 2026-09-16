import { html, type SafeHtml } from "./html.js";
import type {
  CertificateValidity,
  IssuanceOption,
  IssuanceSummary,
  IssuedCredentialSummary,
  ProviderAuthentication,
} from "./platform-client.js";

/**
 * The issuance side of the console: what this tenant offers to issue, and what happened to it.
 *
 * ## The gate is shown first, because today it does not open
 *
 * ARF §6.6.2.2 requires a Wallet to authenticate the Credential Issuer **before** requesting a
 * credential, from signed issuer metadata. The wrapped engine produces none, so no wallet can
 * complete a collection — blocker B7, and a wallet has been watched refusing exactly there.
 *
 * So this screen reads the provider-authentication evidence and puts it at the top. A console that
 * showed offers and transactions without it would let an operator publish an offer, hand out a link,
 * and discover only from a user that nothing can be collected. The status is read from the platform
 * and never assumed: when it cannot be read, the screen says so rather than showing a reassuring
 * default.
 *
 * ## Revocation is offered the way the domain allows it
 *
 * `AS-AP-07-007` (`VCR_04`) makes revocation irreversible. The platform enforces it; this screen
 * simply does not offer the move the platform would refuse — a revoked attestation has no actions,
 * and reinstatement appears only for a suspended one.
 */

const STATUS_TONE: Readonly<Record<string, string>> = {
  ISSUED: "ok",
  VALID: "ok",
  AWAITING_WALLET: "wait",
  CREATED: "wait",
  OFFER_READY: "wait",
  ELIGIBILITY_CHECK: "wait",
  ISSUING: "wait",
  SUSPENDED: "wait",
  EXPIRED: "muted",
  CANCELLED: "muted",
  NOT_ELIGIBLE: "muted",
  REVOKED: "bad",
  TRUST_ERROR: "bad",
  PROTOCOL_ERROR: "bad",
};

const chip = (status: string, failureCode?: string): SafeHtml => html`
  <span class="chip chip-${STATUS_TONE[status] ?? "muted"}">${status}</span>${
    failureCode ? html` <code class="failure">${failureCode}</code>` : ""
  }
`;

const when = (iso?: string): string => (iso ? iso.slice(0, 19).replace("T", " ") : "—");

/** The trust gate, stated as what a Wallet would find rather than as a health tick. */
const gatePanel = (gate?: ProviderAuthentication): SafeHtml => {
  if (!gate) {
    return html`<p class="notice warn">
      The provider-authentication evidence could not be read, so this screen cannot say whether a
      wallet could authenticate the issuer. It is not reporting that it can.
    </p>`;
  }
  if (gate.error) {
    // The platform's own message, because it is the actionable half: "the provider has no engine
    // tenant yet" tells an operator what to do, and a generic sentence here would throw that away.
    return html`<p class="notice warn">
      <strong>Nothing can be issued yet.</strong>
      ${gate.message ?? "The Attestation Provider is not ready."}
      <code>${gate.error}</code>
    </p>`;
  }
  const usable = gate.walletCanAuthenticateProvider === true;
  const cannotSign = gate.canSignAttestations === false;
  return html`
    ${cannotSign ? expiredCertificateNotice(gate) : ""}
    <div class="notice ${usable ? "info" : "warn"}">
      <p>
        <strong>${
          usable
            ? "A wallet can authenticate this issuer."
            : "A wallet cannot authenticate this issuer, so nothing here can be collected."
        }</strong>
      </p>
      <table class="gate">
        <tr>
          <td>Issuer metadata signed</td>
          <td>${gate.metadataSigned === true ? "yes" : html`<strong>no</strong>`}</td>
          <td class="dim">
            ARF §6.6.2.2 requires the Wallet to authenticate the provider from signed metadata before
            requesting anything. The engine produces none — blocker B7.
          </td>
        </tr>
        <tr>
          <td>Registration certificate published</td>
          <td>${gate.registrationCertificatePresent === true ? "yes" : "no"}</td>
          <td class="dim">
            V0 has no reachable provider of registration certificates (blocker B3). The omission is
            reported, never fabricated.
          </td>
        </tr>
        ${certificateRow("Attestation-signing certificate", gate.certificates?.attestationSigning)}
        ${certificateRow("Access certificate", gate.certificates?.access)}
      </table>
    </div>
  `;
};

/**
 * One certificate's validity, or an honest "not recorded".
 *
 * The platform holds no key material, so this date is all it knows about whether the provider can
 * still sign. An absent date is reported as absent: a provider provisioned before migration 0008
 * has none, and showing it as healthy would be the same silence that let an expired certificate go
 * unnoticed for a day on 16 September 2026.
 */
const certificateRow = (label: string, validity?: CertificateValidity): SafeHtml => {
  if (!validity) return html``;
  if (validity.notAfter === null) {
    return html`<tr>
      <td>${label}</td>
      <td class="dim">not recorded</td>
      <td class="dim">
        Provisioned before the platform recorded certificate validity. Re-provision to record it —
        until then this cannot say whether it works.
      </td>
    </tr>`;
  }
  return html`<tr>
    <td>${label}</td>
    <td>${
      validity.expired
        ? html`<span class="chip chip-bad">expired</span>`
        : html`<span class="chip chip-ok">valid</span>`
    }</td>
    <td class="dim">Until ${validity.notAfter.slice(0, 19).replace("T", " ")}</td>
  </tr>`;
};

/**
 * Stated above the trust gate, because it is a different and more immediate failure.
 *
 * The gate is about whether a Wallet can authenticate the issuer. This is about whether the issuer
 * can produce an attestation at all — and when it cannot, every step of the flow still succeeds
 * until the very last one, which is what made it cost an afternoon.
 */
const expiredCertificateNotice = (gate: ProviderAuthentication): SafeHtml => html`
  <div class="notice error">
    <p>
      <strong>This issuer cannot sign.</strong> Its attestation-signing certificate expired
      ${gate.certificates?.attestationSigning?.notAfter?.slice(0, 10) ?? ""}. Offers will still be
      created and a wallet will still resolve them; the refusal comes at the last call of the flow,
      as <code>credential_request_denied</code>.
    </p>
    <p class="hint">Re-provision the Attestation Provider with a current certificate.</p>
  </div>
`;

// --- 1. what this tenant offers to issue --------------------------------------------------------

export const issuanceOffersView = (options: {
  readonly policies: readonly (IssuanceOption & { readonly issuances: number })[];
  readonly gate?: ProviderAuthentication;
  readonly error?: string;
}): SafeHtml => html`
  <h1>Issuance</h1>
  <p class="lead">
    What this tenant offers to issue, and what has happened to each offer. An issuance policy says
    which credential type is issued, to whom it may be issued, and where its attributes come from.
  </p>
  ${options.error ? html`<p class="notice error">${options.error}</p>` : ""}
  ${gatePanel(options.gate)}

  ${
    options.policies.length === 0
      ? html`<p class="empty">No issuance policies yet.</p>`
      : html`
        <table class="offers">
          <thead>
            <tr>
              <th>Policy</th>
              <th>Issues</th>
              <th class="num">Version</th>
              <th class="num">Started</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${options.policies.map(
              (p) => html`
                <tr>
                  <td><a href="/issuance/${p.id}">${p.name}</a></td>
                  <td class="dim">
                    ${p.credentialTypeName} <code class="format">${p.credentialFormat}</code>
                  </td>
                  <td class="num">${
                    p.publishedVersion === null
                      ? html`<span class="chip chip-bad">unpublished</span>`
                      : html`v${String(p.publishedVersion)}`
                  }</td>
                  <td class="num">${String(p.issuances)}</td>
                  <td class="right"><a href="/issuance/${p.id}">Open</a></td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      `
  }

  <h2>Issued attestations</h2>
  <p class="sub">
    Everything a wallet has actually collected, and its status now. Revocation cannot be undone;
    a suspended attestation can be reinstated.
  </p>
  <p class="empty"><a href="/issuance/credentials">Open the register</a></p>
`;

// --- 2. one policy: offer it, and watch what happened -------------------------------------------

export const issuancePolicyView = (options: {
  readonly policy: IssuanceOption;
  readonly issuances: readonly IssuanceSummary[];
  readonly gate?: ProviderAuthentication;
  readonly offer?: {
    readonly uri: string;
    readonly issuanceId: string;
    readonly expiresAt: string;
  };
  readonly qr?: SafeHtml;
  readonly error?: string;
}): SafeHtml => html`
  <p class="crumb"><a href="/issuance">Issuance</a></p>
  <h1>${options.policy.name}</h1>
  <p class="lead">
    Issues <strong>${options.policy.credentialTypeName}</strong>
    <code class="format">${options.policy.credentialFormat}</code>${
      options.policy.publishedVersion === null
        ? html` · <span class="chip chip-bad">no published version</span>`
        : html` · version ${String(options.policy.publishedVersion)}`
    }
  </p>
  ${options.error ? html`<p class="notice error">${options.error}</p>` : ""}
  ${gatePanel(options.gate)}

  <section class="panel">
    <h2>Offer this credential to someone</h2>
    ${
      options.offer
        ? html`
          <div class="invite">
            ${options.qr ?? ""}
            <div class="invite-detail">
              <p class="invite-kind">Scan with the wallet that should receive the credential</p>
              <p class="dim">Issuance ${options.offer.issuanceId}</p>
              <p class="dim">Expires ${when(options.offer.expiresAt)}</p>
              <p class="hint">
                The offer is for one collection. Whether a wallet can complete it depends on the
                trust gate above.
              </p>
            </div>
          </div>
        `
        : html`<p class="dim">No offer open. Create one below.</p>`
    }
    <form method="post" action="/issuance/${options.policy.id}/offer">
      <label>
        <span>Who is this for — your own reference for the subject at the authentic source</span>
        <input type="text" name="subjectReference" required maxlength="200"
               placeholder="fixture-subject-adult">
      </label>
      <div class="actions">
        <button type="submit" ${options.policy.publishedVersion === null ? "disabled" : ""}>
          Create the offer
        </button>
      </div>
      <p class="hint">
        Eligibility is evaluated now, against the attributes as the authentic source returns them —
        before they are narrowed for the credential. An ineligible subject settles here rather than
        after a wallet has been invited.
      </p>
    </form>
  </section>

  <section>
    <h2>Issuances under this policy</h2>
    ${
      options.issuances.length === 0
        ? html`<p class="empty">Nothing yet.</p>`
        : html`
          <table class="presentations">
            <thead>
              <tr>
                <th>Reference</th><th>Status</th><th>Started</th><th>Expires</th>
              </tr>
            </thead>
            <tbody>
              ${options.issuances.map(
                (i) => html`
                  <tr>
                    <td><code>${i.businessReference ?? i.issuanceId.slice(0, 8)}</code></td>
                    <td>${chip(i.status, i.failureCode)}</td>
                    <td class="dim">${when(i.createdAt)}</td>
                    <td class="dim">${when(i.expiresAt)}</td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        `
    }
  </section>
`;

// --- 3. the register of what was actually collected ---------------------------------------------

export const issuedCredentialsView = (options: {
  readonly credentials: readonly IssuedCredentialSummary[];
  readonly notice?: string;
  readonly error?: string;
}): SafeHtml => html`
  <p class="crumb"><a href="/issuance">Issuance</a></p>
  <h1>Issued attestations</h1>
  <p class="lead">
    What a wallet has actually collected. <strong>Revocation cannot be undone</strong> — a revoked
    attestation stays revoked, and only a suspended one can be reinstated.
  </p>
  ${options.error ? html`<p class="notice error">${options.error}</p>` : ""}
  ${options.notice ? html`<p class="notice info">${options.notice}</p>` : ""}

  ${
    options.credentials.length === 0
      ? html`<p class="empty">
          Nothing has been issued. While the trust gate is closed no wallet can collect a credential,
          so this register stays empty however many offers are created.
        </p>`
      : html`
        <table class="presentations">
          <thead>
            <tr>
              <th>Attestation</th><th>Status</th><th>Issued</th><th>Status changed</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${options.credentials.map(
              (c) => html`
                <tr>
                  <td><code>${c.issuedCredentialId.slice(0, 8)}</code></td>
                  <td>${chip(c.status)}</td>
                  <td class="dim">${when(c.issuedAt)}</td>
                  <td class="dim">${when(c.statusChangedAt)}</td>
                  <td class="right">${statusActions(c)}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      `
  }
`;

/** Only the moves the platform would accept. A revoked attestation has none. */
const statusActions = (c: IssuedCredentialSummary): SafeHtml => {
  if (c.status === "REVOKED") return html`<span class="dim">—</span>`;
  const action = (status: string, label: string) => html`
    <form method="post" action="/issuance/credentials/${c.issuedCredentialId}/status" class="inline">
      <input type="hidden" name="status" value="${status}">
      <button type="submit" class="link">${label}</button>
    </form>
  `;
  return c.status === "SUSPENDED"
    ? html`${action("VALID", "Reinstate")} ${action("REVOKED", "Revoke")}`
    : html`${action("SUSPENDED", "Suspend")} ${action("REVOKED", "Revoke")}`;
};
