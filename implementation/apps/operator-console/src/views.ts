import { html, type SafeHtml } from "./html.js";
import type { CreatedPresentation, PresentationView } from "./platform-client.js";
import { renderQrWithValue } from "./qr.js";
import type { ReachabilityProblem } from "./reachability.js";

/**
 * The console's screens.
 *
 * Separated from routing so each one is a pure function of the data it renders — which is also what
 * makes them testable without a server.
 */

export interface RunContext {
  readonly platformCommit: string;
  readonly engineDigest: string;
  readonly trustEnvironment: string;
}

export const loginView = (error?: string): SafeHtml => html`
  <h1>Sign in</h1>
  <p class="lead">
    One shared operator credential. This console holds a tenant API key server-side and never sends it
    to the browser.
  </p>
  ${error ? html`<p class="notice error">${error}</p>` : ""}
  <form method="post" action="/login">
    <fieldset>
      <legend>Operator</legend>
      <label>
        <span>Password</span>
        <input type="password" name="password" autocomplete="current-password" required autofocus>
      </label>
      <button type="submit">Sign in</button>
    </fieldset>
  </form>
`;

/**
 * The test driver.
 *
 * The policy id is typed in rather than chosen from a list, because **the API has no list route** —
 * see `docs/web-interface-proposal.md` §5. That is stated on the page rather than hidden behind a
 * placeholder, so the gap is visible to whoever uses it instead of looking like a design choice.
 */
export const testDriverView = (options: {
  readonly defaultPolicyId?: string;
  readonly sameDeviceAvailable: boolean;
  readonly error?: string;
}): SafeHtml => html`
  <h1>Test driver</h1>
  <p class="lead">
    Starts one presentation and follows it to a terminal state. Use it instead of assembling a QR by
    hand: a mistyped URI or a mistimed poll produces a failure that looks like a platform or wallet
    failure, which is what a run sheet exists to distinguish.
  </p>
  ${options.error ? html`<p class="notice error">${options.error}</p>` : ""}
  <form method="post" action="/presentations">
    <fieldset>
      <legend>Start a presentation</legend>
      <label>
        <span>Published presentation policy (UUID)</span>
        <input type="text" name="policyId" required spellcheck="false"
               value="${options.defaultPolicyId ?? ""}"
               pattern="[0-9a-fA-F-]{36}" placeholder="00000000-0000-0000-0000-000000000000">
      </label>
      <label>
        <span>Policy version — leave empty for the latest published version</span>
        <input type="number" name="policyVersion" min="1" step="1">
      </label>
      <label>
        <span>Business reference — your own identifier for this run</span>
        <input type="text" name="businessReference" required maxlength="200"
               value="run-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "")}">
      </label>
      <label>
        <span>Interaction</span>
        <select name="interactionType">
          <option value="SAME_DEVICE"${options.sameDeviceAvailable ? "" : " disabled"}>
            Same device — the wallet and the browser are the same phone (the tested V0 path)
          </option>
          <option value="QR">QR — cross-device, with the ADR 0009 mitigations and caveats</option>
        </select>
      </label>
      <button type="submit">Start</button>
    </fieldset>
  </form>
  ${
    options.sameDeviceAvailable
      ? ""
      : html`<p class="notice warn">
        Same-device is unavailable: <code>TEST_START_PUBLIC_URL</code> is not configured, so there is no
        publicly reachable page for the phone to open. Cross-device (QR) needs no page of ours and works
        now.
      </p>`
  }
  <h2>Two things this page does not do</h2>
  <table>
    <tr>
      <td class="k">List your policies</td>
      <td>
        The platform API has no list route — every route is <code>POST</code> or <code>GET</code> by id.
        Adding one is real API work with an enumeration-exposure decision attached, so the policy id is
        typed in for now.
      </td>
    </tr>
    <tr>
      <td class="k">Show anything the API does not return</td>
      <td>
        There is no raw-response view, and there will not be one. The result panel shows exactly what the
        result policy emitted.
      </td>
    </tr>
  </table>
`;

export const presentationView = (options: {
  readonly created: CreatedPresentation;
  readonly view: PresentationView;
  readonly qrValue?: string;
  readonly qrLabel?: string;
  readonly startUrl?: string;
  readonly reachability: readonly ReachabilityProblem[];
  readonly run: RunContext;
}): SafeHtml => {
  const { created, view, run } = options;
  const terminal = isTerminal(view.status);

  return html`
    <h1>Presentation</h1>
    <p class="lead">
      <code>${view.presentationId}</code> · policy <code>${view.policyId}</code> v${view.policyVersion}
      · expires ${view.expiresAt}
    </p>

    ${(created.warnings ?? []).map(
      (w) => html`<p class="notice warn"><strong>${w.code}</strong> — ${w.message}</p>`,
    )}

    ${options.reachability.length > 0 ? unreachableNotice(options.reachability) : ""}

    <div class="two">
      <section>
        <h2>Hand this to the wallet</h2>
        ${
          options.qrValue && options.qrLabel
            ? renderQrWithValue(options.qrValue, options.qrLabel)
            : html`<p class="notice error">No interaction URI was returned.</p>`
        }
        ${
          options.startUrl
            ? html`<p class="notice info">
              The QR carries <strong>our start page</strong> over HTTPS, not the OpenID4VP request. The
              phone opens it and the wallet is invoked <em>on the phone</em> — so the OpenID4VP flow is
              <strong>same-device</strong>, even though a QR was used to get there. Record it that way.
            </p>`
            : ""
        }
      </section>

      <section>
        <h2>Status</h2>
        <table id="status-table" data-presentation="${view.presentationId}"
               data-terminal="${terminal ? "true" : "false"}">
          <tr><td class="k">Status</td><td><span class="status ${view.status}" id="status-value">${view.status}</span></td></tr>
          <tr><td class="k">Business reference</td><td class="mono">${view.businessReference}</td></tr>
          <tr><td class="k">Failure code</td><td class="mono" id="failure-value">${view.failureCode ?? "—"}</td></tr>
        </table>
        <p id="poll-note" class="notice info">
          ${terminal ? "Terminal state reached; polling stopped." : "Polling every two seconds…"}
        </p>

        <h2>Result</h2>
        <div id="result-block">${resultBlock(view)}</div>
      </section>
    </div>

    <h2>Run record</h2>
    <p class="lead">
      Emitted here so it is not reassembled from memory afterwards. Copy it into the run sheet.
    </p>
    <pre class="record" id="run-record">${runRecord(view, run, options.qrLabel)}</pre>
    <form method="get" action="/"><button class="secondary" type="submit">Start another</button></form>
    <script src="/assets/console.js" defer></script>
  `;
};

/**
 * Says plainly that a phone cannot complete this interaction, and which variable to change.
 *
 * Shown above the QR rather than below it, because the whole failure mode being prevented is an
 * operator scanning a code that never had a chance of working and then debugging the wallet.
 */
const unreachableNotice = (problems: readonly ReachabilityProblem[]): SafeHtml => html`
  <div class="notice error">
    <p>
      <strong>A phone cannot complete this interaction.</strong> The QR is valid and the platform is
      working; these URLs are simply not reachable from a phone, so scanning it will fail in the wallet
      for a reason that has nothing to do with the wallet.
    </p>
    <table>
      ${problems.map(
        (p) => html`<tr>
          <td class="k mono">${p.setting}</td>
          <td><code>${p.value}</code><br>${p.reason}</td>
        </tr>`,
      )}
    </table>
    <p>
      A phone test needs public HTTPS for all three — blocker <strong>B5</strong>. That is what
      <code>docs/test-session-gateway.md</code> and <code>docs/test-session-vm.md</code> are for. Set the
      variables <em>before</em> <code>docker compose up</code>: the engine bakes them into every URL it
      emits, so changing them afterwards breaks sessions a wallet already holds.
    </p>
  </div>
`;

/**
 * The result panel.
 *
 * Renders `result.claims` and nothing else. No raw payload, no VP token, no disclosure list — the API
 * does not return them and the console must not grow a way to ask. `AS-RP-01-002` (`OIA_16`) constrains
 * the customer-facing result, and in the hosted profile the platform is the Relying Party Instance, so
 * this panel is bound by it exactly as the API response is.
 *
 * The policy version is printed beside the values, so a screenshot says which result policy produced
 * them.
 */
const resultBlock = (view: PresentationView): SafeHtml => {
  if (!view.result) {
    return html`<p class="lead">No result yet. A result appears only on a verified outcome.</p>`;
  }
  const entries = Object.entries(view.result.claims);
  return html`
    <table>
      ${entries.map(([key, value]) => html`<tr><td class="k mono">${key}</td><td class="mono">${formatClaim(value)}</td></tr>`)}
    </table>
    <p class="lead">
      Emitted by result policy of <code>${view.policyId}</code> v${view.policyVersion}. These are the
      only values the platform returns; nothing else was retained.
    </p>
  `;
};

/** Claim values are rendered as text, never as markup, and never via `JSON.stringify` of an object
 * graph that might carry something unexpected — objects are summarised rather than dumped. */
const formatClaim = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} value${value.length === 1 ? "" : "s"}]`;
  }
  return "{object}";
};

export const healthView = (options: {
  readonly platform: string;
  readonly engine: string;
  readonly run: RunContext;
}): SafeHtml => html`
  <h1>Health</h1>
  <table>
    <tr><td class="k">Platform API</td><td>${options.platform}</td></tr>
    <tr><td class="k">Engine reachable</td><td>${options.engine}</td></tr>
    <tr><td class="k">Trust environment</td><td>${options.run.trustEnvironment}</td></tr>
    <tr><td class="k">Platform commit</td><td class="mono">${options.run.platformCommit}</td></tr>
    <tr><td class="k">Engine image digest</td><td class="mono">${options.run.engineDigest}</td></tr>
  </table>
  <p class="lead">
    The engine's own admin API and Swagger are deliberately not linked from here. They are a full
    administrative surface and stay on localhost — <code>docs/test-session-gateway.md</code> §1c.
  </p>
`;

const TERMINAL = ["VERIFIED", "FAILED", "EXPIRED", "DECLINED_BY_USER", "CANCELLED"] as const;

export const isTerminal = (status: string): boolean =>
  (TERMINAL as readonly string[]).includes(status);

/**
 * The run-record block.
 *
 * Fields match the VaaS run sheet's template, including the ones this run does not use — a template
 * that changes shape between runs cannot be compared across them.
 */
const runRecord = (
  view: PresentationView,
  run: RunContext,
  interactionLabel?: string,
): string =>
  [
    `presentationId:        ${view.presentationId}`,
    `businessReference:     ${view.businessReference}`,
    `policy:                ${view.policyId} v${view.policyVersion}`,
    `interaction:           ${interactionLabel ?? "—"}`,
    `status:                ${view.status}`,
    `failureCode:           ${view.failureCode ?? "—"}`,
    `expiresAt:             ${view.expiresAt}`,
    `trustEnvironment:      ${run.trustEnvironment}`,
    `platformCommit:        ${run.platformCommit}`,
    `engineImageDigest:     ${run.engineDigest}`,
    "walletBuild:           <official | EDTP test wallet + APK SHA-256>",
    "walletDeviations:      <none | WD-1,…>",
    "registrationCertCheck: <off | on>",
    "phoneNetwork:          <mobile data | other>",
  ].join("\n");

/**
 * The page's only JavaScript, served as a file so the CSP can refuse inline script.
 *
 * It polls the console's own JSON endpoint — which returns exactly what the platform API returned — and
 * updates three fields. It writes nothing to browser storage: `docs/web-interface-proposal.md` §3.1
 * forbids it, and a poller that cached a result would be the easiest way to break that rule by accident.
 */
export const CONSOLE_JS = `"use strict";
(function () {
  var table = document.getElementById("status-table");
  if (!table || table.dataset.terminal === "true") return;

  var id = table.dataset.presentation;
  var statusValue = document.getElementById("status-value");
  var failureValue = document.getElementById("failure-value");
  var resultBlock = document.getElementById("result-block");
  var pollNote = document.getElementById("poll-note");
  var attempts = 0;

  function stop(message) {
    if (pollNote) pollNote.textContent = message;
  }

  function tick() {
    attempts += 1;
    // A presentation that has not reached a terminal state in ten minutes has expired or is stuck;
    // polling for ever would hide that behind a spinner.
    if (attempts > 300) { stop("Stopped polling after ten minutes. Reload to resume."); return; }

    fetch("/presentations/" + encodeURIComponent(id) + "/status.json", {
      headers: { accept: "application/json" },
      credentials: "same-origin"
    }).then(function (r) {
      if (!r.ok) throw new Error("status " + r.status);
      return r.json();
    }).then(function (view) {
      if (statusValue) {
        statusValue.textContent = view.status;
        statusValue.className = "status " + view.status;
      }
      if (failureValue) failureValue.textContent = view.failureCode || "—";
      if (resultBlock && view.resultHtml) resultBlock.innerHTML = view.resultHtml;
      if (view.terminal) { stop("Terminal state reached; polling stopped."); return; }
      window.setTimeout(tick, 2000);
    }).catch(function (error) {
      stop("Polling failed (" + error.message + "). Reload to resume.");
    });
  }

  window.setTimeout(tick, 2000);
})();
`;

/** The JSON the poller consumes. Rendered server-side so escaping stays in one place. */
export const statusPayload = (view: PresentationView): Record<string, unknown> => ({
  status: view.status,
  failureCode: view.failureCode ?? null,
  terminal: isTerminal(view.status),
  // The result is rendered to markup on the server, escaped there, rather than sent as data for the
  // browser to format. One escaping implementation, and `innerHTML` receives only our own output.
  resultHtml: resultBlock(view).__safe,
});
