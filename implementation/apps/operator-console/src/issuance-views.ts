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

  <p class="actions"><a href="/issuance/new" class="button">Define a credential to issue</a></p>

  ${
    options.policies.length === 0
      ? html`<p class="empty">
          Nothing is defined yet. <a href="/issuance/new">Define a credential to issue</a> — what it
          is, who may receive one, and how it is collected.
        </p>`
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
  <p class="sub">
    A status marked <strong>not in effect</strong> is one the platform intends and the wrapped
    engine has not acknowledged — the status list a Relying Party reads may still say something
    else. Repeating the action retries it; the call is idempotent.
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
                  <td>${chip(c.status)}${
                    c.statusConfirmed === false
                      ? html` <span class="chip chip-bad" title="The engine has not acknowledged this
                          status, so the status list a Relying Party reads may not carry it. Repeat
                          the action to retry — it is idempotent.">not in effect</span>`
                      : ""
                  }</td>
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

// --- 4. defining what this tenant issues --------------------------------------------------------

/** How many attribute rows the form offers. Blank ones are ignored. */
export const ATTRIBUTE_ROWS = 6;

/**
 * The issuance builder — the screen the console was missing.
 *
 * The verification side has had `/offers/new` since the console existed: an entity defines what it
 * asks for. The issuance side had only the operating screens, so an entity could offer and monitor
 * what somebody else had defined through the API, and "define a credential to issue" was not a
 * thing the console could do at all.
 *
 * ## It offers what is registered, and nothing else
 *
 * Eligibility evaluators and authentic-source connectors are **registered at startup** and resolved
 * then, not at runtime — a deliberate choice recorded on `EligibilityRuleRef`: a rule that decides
 * whether someone receives an attestation about themselves should be readable code under review,
 * not a string in a database. So this form lists the ones that exist and offers no free-text box
 * for either. Today that is two evaluators and **one** connector.
 *
 * ## And it says the connector is a fixture
 *
 * The single connector is a fixture, and the screen says so where the choice is made rather than in
 * a footnote. An operator who defines a credential here gets one whose attribute values come from
 * test data, and finding that out after issuing would be the kind of surprise this console exists
 * to prevent. The V0 plan §7.2 requires the connector to be labelled a fixture in its own name; the
 * console says it again in words.
 *
 * ## Three objects, one form
 *
 * A credential type, a policy and a published version are created together. They are three business
 * objects and the platform keeps them separate — the type is what the attestation *is*, the policy
 * who may receive one and where the values come from, the version an immutable answer — but asking
 * an operator to fill three forms to express one intention would be modelling leaking into a
 * screen.
 */
export const newIssuanceView = (options: {
  readonly providers: readonly { readonly id: string; readonly name: string }[];
  readonly evaluators: readonly string[];
  readonly connectors: readonly string[];
  readonly gate?: ProviderAuthentication;
  readonly error?: string;
  readonly submitted?: Readonly<Record<string, string>>;
}): SafeHtml => {
  const was = (field: string, fallback = ""): string => options.submitted?.[field] ?? fallback;
  const selected = (field: string, value: string, fallback = ""): string =>
    (options.submitted?.[field] ?? fallback) === value ? " selected" : "";

  return html`
    <p class="crumb"><a href="/issuance">Issuance</a></p>
    <h1>Define a credential to issue</h1>
    <p class="lead">
      What the attestation <strong>is</strong>, who may receive one, and how it is collected. This
      creates a credential type, a policy over it, and a published version — published, so it can be
      offered immediately. A published version is <strong>immutable</strong>: changing any of this
      later means publishing a new version, and attestations already issued keep the terms they were
      issued under.
    </p>
    ${options.error ? html`<p class="notice error">${options.error}</p>` : ""}
    ${gatePanel(options.gate)}

    ${
      options.providers.length === 0
        ? html`<p class="notice warn">
            This tenant has no Attestation Provider, so there is nothing to issue under. A provider
            is registered and provisioned through the API — it needs an engine tenant and a signing
            certificate, neither of which belongs in a form.
          </p>`
        : html`
      <form method="post" action="/issuance/new">
        <fieldset>
          <legend>1 · What is issued</legend>
          <label>
            <span>Issued by</span>
            <select name="attestationProviderId" required>
              ${options.providers.map(
                (p) => html`<option value="${p.id}"${selected("attestationProviderId", p.id)}>
                  ${p.name}
                </option>`,
              )}
            </select>
          </label>
          <label>
            <span>Name — what a wallet shows the holder</span>
            <input type="text" name="name" required maxlength="200"
                   value="${was("name")}" placeholder="Employee badge">
          </label>
          <label>
            <span>Format</span>
            <select name="format" required>
              <option value="dc+sd-jwt"${selected("format", "dc+sd-jwt", "dc+sd-jwt")}>
                SD-JWT VC (dc+sd-jwt)
              </option>
              <option value="mso_mdoc"${selected("format", "mso_mdoc")}>mdoc (mso_mdoc)</option>
            </select>
          </label>
          <label>
            <span>Type identifier — the <code>vct</code> for SD-JWT VC, the <code>doctype</code> for mdoc</span>
            <input type="text" name="typeIdentifier" required maxlength="500"
                   value="${was("typeIdentifier")}" placeholder="urn:example:employee-badge:1">
          </label>
          <p class="hint">
            Choose an identifier under a namespace you control. One that resembles an official
            identifier without being one hides a gap instead of recording it.
          </p>
        </fieldset>

        <fieldset>
          <legend>2 · Its attributes</legend>
          <p class="hint">
            Leave a row blank to skip it. At least one attribute is required, and a mandatory one
            must be present for the attestation to be issued at all.
          </p>
          <table class="attributes">
            <thead>
              <tr><th>Attribute name</th><th>Label shown to the holder</th><th>Type</th><th>Mandatory</th></tr>
            </thead>
            <tbody>
              ${Array.from({ length: ATTRIBUTE_ROWS }, (_, i) => {
                const n = String(i);
                return html`
                  <tr>
                    <td><input type="text" name="claimPath${n}" maxlength="200"
                               value="${was(`claimPath${n}`)}"
                               placeholder="${i === 0 ? "employee_id" : ""}"></td>
                    <td><input type="text" name="claimLabel${n}" maxlength="200"
                               value="${was(`claimLabel${n}`)}"
                               placeholder="${i === 0 ? "Employee number" : ""}"></td>
                    <td>
                      <select name="claimType${n}">
                        <option value="string"${selected(`claimType${n}`, "string", "string")}>text</option>
                        <option value="number"${selected(`claimType${n}`, "number")}>number</option>
                        <option value="boolean"${selected(`claimType${n}`, "boolean")}>yes/no</option>
                        <option value="date"${selected(`claimType${n}`, "date")}>date</option>
                      </select>
                    </td>
                    <td class="centre">
                      <input type="checkbox" name="claimMandatory${n}" value="on"
                             ${options.submitted && !options.submitted[`claimMandatory${n}`] ? "" : "checked"}>
                    </td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
          <p class="hint">
            For an mdoc the attribute name is the element within its namespace; the namespace comes
            from the doctype above.
          </p>
        </fieldset>

        <fieldset>
          <legend>3 · Who may receive one, and where the values come from</legend>
          <label>
            <span>Eligibility rule</span>
            <select name="evaluator" required>
              ${options.evaluators.map(
                (e) => html`<option value="${e}"${selected("evaluator", e)}>${e}</option>`,
              )}
            </select>
          </label>
          <label>
            <span>Minimum age, when the rule is <code>MinimumAge</code></span>
            <input type="number" name="minimumAgeYears" min="0" max="150"
                   value="${was("minimumAgeYears", "18")}">
          </label>
          <p class="hint">
            The rule is evaluated against the attributes as the authentic source returns them,
            <strong>before</strong> they are narrowed for the credential — so a rule can read a date
            of birth that the attestation itself will not carry.
          </p>
          <label>
            <span>Authentic source</span>
            <select name="connector" required>
              ${options.connectors.map(
                (c) => html`<option value="${c}"${selected("connector", c)}>${c}</option>`,
              )}
            </select>
          </label>
          ${
            options.connectors.every((c) => c.toLowerCase().includes("fixture"))
              ? html`<p class="notice warn">
                  <strong>The only authentic source available is a fixture.</strong> Whatever is
                  defined here will be issued with <strong>test data</strong>, not with attributes
                  any authoritative party asserted. A real source is a connector somebody writes and
                  registers; it is not a setting on this page.
                </p>`
              : ""
          }
        </fieldset>

        <fieldset>
          <legend>4 · How it is collected, and for how long it lasts</legend>
          <label>
            <span>Purpose — shown to the holder when the wallet asks for approval</span>
            <input type="text" name="purpose" required maxlength="300"
                   value="${was("purpose")}"
                   placeholder="Issue an employee badge to a verified employee">
          </label>
          <label>
            <span>Valid for (days)</span>
            <input type="number" name="validityDays" required min="1" max="3650"
                   value="${was("validityDays", "30")}">
          </label>
          <label>
            <span>Collection flow</span>
            <select name="flow" required>
              <option value="PRE_AUTHORIZED_CODE"${selected("flow", "PRE_AUTHORIZED_CODE", "PRE_AUTHORIZED_CODE")}>
                Pre-authorized code — the holder is known before the offer is made
              </option>
              <option value="AUTHORIZATION_CODE"${selected("flow", "AUTHORIZATION_CODE")}>
                Authorization code — the holder authenticates during collection
              </option>
            </select>
          </label>
          <label>
            <span>Holder binding</span>
            <select name="holderBinding" required>
              <option value="KEY_BOUND"${selected("holderBinding", "KEY_BOUND", "KEY_BOUND")}>
                Key-bound — only this wallet can present it
              </option>
              <option value="BEARER"${selected("holderBinding", "BEARER")}>
                Bearer — anyone holding it can present it
              </option>
            </select>
          </label>
          <label class="inline-check">
            <input type="checkbox" name="statusListEnabled" value="on"
                   ${options.submitted && !options.submitted.statusListEnabled ? "" : "checked"}>
            <span>Maintain a status list, so attestations can be revoked</span>
          </label>
          <label class="inline-check">
            <input type="checkbox" name="suspensionAllowed" value="on"
                   ${options.submitted?.suspensionAllowed ? "checked" : ""}>
            <span>Allow suspension as well — reversible, unlike revocation</span>
          </label>
          <p class="hint">
            Revocation cannot be undone (<code>AS-AP-07-007</code>). Suspension is the mechanism for
            a temporary hold, and it exists only if it is allowed here.
          </p>
        </fieldset>

        <fieldset>
          <legend>5 · The Rulebook that governs it</legend>
          <p class="hint">
            <strong>Trust configuration, not documentation.</strong> ARF §6.3.2.4 makes the Rulebook
            the source of the anchors a wallet uses to verify this attestation's signature.
          </p>
          <label>
            <span>Rulebook identifier</span>
            <input type="text" name="rulebookIdentifier" required maxlength="500"
                   value="${was("rulebookIdentifier")}" placeholder="urn:example:rulebook:employee-badge">
          </label>
          <label>
            <span>Rulebook version</span>
            <input type="text" name="rulebookVersion" required maxlength="50"
                   value="${was("rulebookVersion", "1.0")}">
          </label>
        </fieldset>

        <div class="actions">
          <button type="submit">Define and publish</button>
          <a href="/issuance" class="cancel">Cancel</a>
        </div>
      </form>
    `
    }
  `;
};
