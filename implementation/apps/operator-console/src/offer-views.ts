import { html, type SafeHtml } from "./html.js";
import type {
  IntendedUseOption,
  PolicyOption,
  PresentationSummary,
  RegisteredCredential,
  ServiceOption,
} from "./platform-client.js";

/**
 * The verification offers a Relying Party operates: what it asks for, and what came back.
 *
 * ## Why "offer" and not "presentation policy"
 *
 * The API's noun is `PresentationPolicy`, and it stays that in the API. On screen it is an **offer**,
 * because that is what the person operating it is doing: publishing something a wallet holder can be
 * asked to satisfy. Naming things by what people recognise rather than by how the system is built is
 * the one place the console is allowed to differ from the contract.
 *
 * ## The registration bound, made structural
 *
 * The builder offers exactly the credentials and claims the Relying Party **registered** on the
 * intended use it is defined under, and nothing else. A policy is validated against that registration
 * at publication — extending a registered claim path is allowed, prefixing it is not — so a screen
 * with free-text claim entry would collect a request the platform then refuses. Reading the options
 * out of the registration makes the wrong request unbuildable instead of explaining it afterwards.
 *
 * ## What a list never carries
 *
 * A presentation **result**. `AS-RP-01-002` (`OIA_16`) binds the platform as the Relying Party
 * Instance, and enumerating results in bulk is a different act from reading one — so the per-offer
 * table shows status and timing, and a result is fetched one identifier at a time by following the
 * row. That is an API property, not a rendering choice, and this screen cannot work around it.
 */

const STATUS_TONE: Readonly<Record<string, string>> = {
  VERIFIED: "ok",
  AWAITING_WALLET: "wait",
  REQUEST_READY: "wait",
  CREATED: "wait",
  PRESENTATION_RECEIVED: "wait",
  VERIFYING: "wait",
  EXPIRED: "muted",
  CANCELLED: "muted",
  DECLINED_BY_USER: "muted",
  NOT_VERIFIED: "bad",
  TRUST_ERROR: "bad",
  PROTOCOL_ERROR: "bad",
};

const statusChip = (status: string, failureCode?: string): SafeHtml => html`
  <span class="chip chip-${STATUS_TONE[status] ?? "muted"}">${status}</span>${
    failureCode ? html` <code class="failure">${failureCode}</code>` : ""
  }
`;

/** `["address", null, "locality"]` reads as `address[].locality` — the OpenID4VP path shape. */
const claimPathLabel = (path: readonly (string | number | null)[]): string =>
  path
    .map((p) => (p === null ? "[]" : typeof p === "number" ? `[${p}]` : `.${p}`))
    .join("")
    .replace(/^\./, "");

const credentialLabel = (c: RegisteredCredential): string =>
  c.vctValues?.[0] ?? c.doctype ?? c.format;

// --- 1. the offers a Relying Party operates -----------------------------------------------------

export const offersView = (options: {
  readonly offers: readonly (PolicyOption & { readonly presentations: number })[];
  readonly services: readonly ServiceOption[];
  readonly error?: string;
  readonly notice?: string;
}): SafeHtml => html`
  <h1>Verification offers</h1>
  <p class="lead">
    What this tenant asks wallet holders to present, and how each one is doing. An offer is a
    published presentation policy: pick one to get a QR or a same-device link, and to see what has
    been presented against it.
  </p>
  ${options.error ? html`<p class="notice error">${options.error}</p>` : ""}
  ${options.notice ? html`<p class="notice info">${options.notice}</p>` : ""}

  ${
    options.services.length === 0
      ? html`<p class="notice warn">
          This tenant has no Relying Party Service yet, so there is nothing to define an offer under.
          A Service and its intended use are registration, not configuration — they record what the
          Registrar authorised this party to ask for.
        </p>`
      : html`<p><a class="button" href="/offers/new">Define an offer</a></p>`
  }

  ${
    options.offers.length === 0
      ? html`<p class="empty">No offers yet.</p>`
      : html`
        <table class="offers">
          <thead>
            <tr>
              <th>Offer</th>
              <th>Relying Party Service</th>
              <th class="num">Version</th>
              <th class="num">Presented</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${options.offers.map(
              (offer) => html`
                <tr>
                  <td><a href="/offers/${offer.id}">${offer.name}</a></td>
                  <td class="dim">${offer.relyingPartyServiceName}</td>
                  <td class="num">${
                    offer.publishedVersion === null
                      ? html`<span class="chip chip-bad">unpublished</span>`
                      : html`v${String(offer.publishedVersion)}`
                  }</td>
                  <td class="num">${String(offer.presentations)}</td>
                  <td class="right"><a href="/offers/${offer.id}">Open</a></td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      `
  }
`;

// --- 2. defining one ----------------------------------------------------------------------------

export const newOfferView = (options: {
  readonly services: readonly ServiceOption[];
  readonly selectedServiceId?: string;
  readonly intendedUses: readonly IntendedUseOption[];
  /** Published URLs of the issuer trust lists this deployment has loaded. */
  readonly trustSources?: readonly string[];
  readonly error?: string;
}): SafeHtml => {
  const service = options.selectedServiceId;
  const trustSources = options.trustSources ?? [];

  return html`
    <h1>Define a verification offer</h1>
    <p class="lead">
      Choose what a wallet holder will be asked to present. The credentials and attributes below are
      the ones this Relying Party <strong>registered</strong> — an offer cannot ask for anything
      outside them, so the choice here is the whole choice.
    </p>
    ${options.error ? html`<p class="notice error">${options.error}</p>` : ""}

    <form method="get" action="/offers/new">
      <fieldset>
        <legend>1 · Relying Party Service</legend>
        <label>
          <span>Which Service is this offer operated under</span>
          <select name="serviceId" onchange="this.form.submit()">
            <option value="" ${service ? "" : "selected"} disabled>Choose a Service…</option>
            ${options.services.map(
              (s) => html`<option value="${s.id}"${s.id === service ? " selected" : ""}>
                ${s.name} — ${s.serviceIdentifier}
              </option>`,
            )}
          </select>
        </label>
        <noscript><button type="submit">Continue</button></noscript>
      </fieldset>
    </form>

    ${
      !service
        ? ""
        : options.intendedUses.length === 0
          ? html`<p class="notice warn">
              This Service has no intended use, so it has registered nothing and can ask for nothing.
              An intended use is what records the credentials and claim paths the Registrar
              authorised.
            </p>`
          : html`
            <form method="post" action="/offers">
              <input type="hidden" name="serviceId" value="${service}">
              ${options.intendedUses.map((use) => renderIntendedUse(use))}
              ${renderTrustSources(trustSources)}

              <fieldset>
                <legend>4 · What the holder is told, and what you keep</legend>
                <label>
                  <span>Offer name — how it appears in your list</span>
                  <input type="text" name="name" required maxlength="200"
                         placeholder="Adult check at sign-up">
                </label>
                <label>
                  <span>Purpose — <strong>shown to the holder by their wallet</strong></span>
                  <input type="text" name="purpose" required maxlength="300"
                         placeholder="Confirm the customer is an adult">
                </label>
                <label>
                  <span>What you receive</span>
                  <select name="resultKind" id="resultKind">
                    <option value="VERIFIED_CLAIMS">The attributes themselves</option>
                    <option value="AGE_OVER_18">
                      Only whether the holder is 18 or over — the date of birth is discarded
                    </option>
                  </select>
                </label>
                <p class="hint">
                  The second is the minimising choice and the one to prefer where it answers the
                  question. The PID carries no age attribute, so an age check is derived from the
                  date of birth and the date itself never reaches you.
                </p>
                <button type="submit">Publish offer</button>
              </fieldset>
            </form>
          `
    }
  `;
};

const renderTrustSources = (sources: readonly string[]): SafeHtml => html`
  <fieldset>
    <legend>3 · Whose credentials you accept</legend>
    ${
      sources.length === 0
        ? html`<p class="notice error">
            No list of trusted issuers is loaded in this deployment, so no offer can be published. A
            presentation checked against no list would accept a credential signed by anyone.
          </p>`
        : sources.map(
            (ref, index) => html`
              <label class="inline-check">
                <input type="checkbox" name="trustSource" value="${ref}" ${index === 0 ? "checked" : ""}>
                <code>${ref}</code>
              </label>
            `,
          )
    }
    <label>
      <span>What the issuers on these lists are</span>
      <select name="trustDomain">
        <option value="PID_PROVIDER">PID Providers</option>
        <option value="EAA_PROVIDER">Providers of (non-qualified) attestations</option>
        <option value="PUB_EAA_PROVIDER">Public-body attestation providers</option>
        <option value="QEAA_PROVIDER">Qualified attestation providers</option>
      </select>
    </label>
    <p class="hint">
      The presented credential's signer must chain to an issuer on one of the ticked lists, or the
      presentation fails. Keep lists of different kinds of issuer in different offers.
    </p>
  </fieldset>
`;

const renderIntendedUse = (use: IntendedUseOption): SafeHtml => html`
  <fieldset>
    <legend>2 · What to ask for — registered under <code>${use.identifier}</code></legend>
    ${use.registeredCredentials.map(
      (credential, index) => html`
        <div class="credential">
          <label class="credential-pick">
            <input type="radio" name="credential"
                   value="${use.id}|${index}"
                   ${index === 0 ? "checked" : ""} required>
            <span>
              <strong>${credentialLabel(credential)}</strong>
              <code class="format">${credential.format}</code>
            </span>
          </label>
          <div class="claims">
            ${credential.claims.map(
              (path) => html`
                <label class="claim">
                  <input type="checkbox" name="claim" value="${use.id}|${index}|${JSON.stringify(path)}">
                  <code>${claimPathLabel(path)}</code>
                </label>
              `,
            )}
          </div>
        </div>
      `,
    )}
    <p class="hint">
      Ask for the fewest attributes that answer your question. Every one you tick is data the holder
      is asked to disclose and that you then hold.
    </p>
  </fieldset>
`;

// --- 3. one offer: the link to give out, and what came back -------------------------------------

export const offerView = (options: {
  readonly offer: PolicyOption;
  readonly presentations: readonly PresentationSummary[];
  readonly interaction?: { readonly uri: string; readonly type: string };
  readonly qr?: SafeHtml;
  readonly startUrl?: string;
  readonly expiresAt?: string;
  readonly sameDeviceAvailable: boolean;
  readonly error?: string;
}): SafeHtml => html`
  <p class="crumb"><a href="/offers">Verification offers</a></p>
  <h1>${options.offer.name}</h1>
  <p class="lead">
    Operated under <strong>${options.offer.relyingPartyServiceName}</strong>${
      options.offer.publishedVersion === null
        ? html` · <span class="chip chip-bad">no published version</span>`
        : html` · version ${String(options.offer.publishedVersion)}`
    }
  </p>
  ${options.error ? html`<p class="notice error">${options.error}</p>` : ""}

  <section class="panel">
    <h2>Ask someone to present</h2>
    ${
      options.interaction
        ? html`
          <div class="invite">
            ${options.qr ?? ""}
            <div class="invite-detail">
              <p class="invite-kind">${
                options.interaction.type === "QR"
                  ? "Cross-device — scan with the wallet"
                  : "Same device — open on the phone holding the wallet"
              }</p>
              ${
                options.startUrl
                  ? html`<p><a href="${options.startUrl}" class="start-link">${options.startUrl}</a></p>`
                  : ""
              }
              ${options.expiresAt ? html`<p class="dim">Expires ${options.expiresAt}</p>` : ""}
              <p class="hint">
                This invitation is for one presentation and is short-lived on purpose: a captured
                link should stop working quickly.
              </p>
            </div>
          </div>
        `
        : html`<p class="dim">No invitation open. Create one below.</p>`
    }
    <form method="post" action="/offers/${options.offer.id}/present">
      <div class="actions">
        <button type="submit" name="interactionType" value="QR"
                ${options.offer.publishedVersion === null ? "disabled" : ""}>
          QR code
        </button>
        <button type="submit" name="interactionType" value="SAME_DEVICE"
                ${
                  options.offer.publishedVersion === null || !options.sameDeviceAvailable
                    ? "disabled"
                    : ""
                }>
          Same-device link
        </button>
      </div>
      ${
        options.sameDeviceAvailable
          ? ""
          : html`<p class="hint">
              Same-device needs a publicly reachable start page, which is not configured. Cross-device
              needs no page of ours and works now.
            </p>`
      }
    </form>
  </section>

  <section>
    <h2>Presented against this offer</h2>
    ${
      options.presentations.length === 0
        ? html`<p class="empty">Nothing yet.</p>`
        : html`
          <table class="presentations">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Status</th>
                <th>Interaction</th>
                <th>Started</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${options.presentations.map(
                (p) => html`
                  <tr>
                    <td><code>${p.businessReference}</code></td>
                    <td>${statusChip(p.status, p.failureCode)}</td>
                    <td class="dim">${p.interactionType}</td>
                    <td class="dim">${p.createdAt.slice(0, 19).replace("T", " ")}</td>
                    <td class="right">
                      <a href="/presentations/${p.presentationId}">Result</a>
                    </td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
          <p class="hint">
            A list carries no result. Follow a row to read one — the platform returns results a single
            identifier at a time, and that is deliberate.
          </p>
        `
    }
  </section>
`;
