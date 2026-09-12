import type { EntityCheck, StabilityVerdict, StepStatus } from "@edtp/registration-client";
import { html, type SafeHtml } from "./html.js";
import { notice } from "./layout.js";
import { renderQr } from "./qr.js";

/**
 * Screens for a registration session at the EUDIW reference RP Registration Service.
 *
 * ## Why this belongs in the console rather than in its own application
 *
 * The console already binds to `127.0.0.1` and refuses to bind anywhere else, and it is
 * deliberately absent from the gateway allow-list (`docs/test-session-gateway.md` §1c). A flow
 * that holds `hash_pid` and mints a private key needs exactly that posture, and building a second
 * application would mean establishing it a second time — which is how one of the two ends up
 * missing it.
 *
 * The session itself needs no public exposure at all: the login QR carries a URL to the EUDI
 * verifier backend, so the phone talks to that backend and never to this machine. Only the
 * operator's browser needs to reach the console.
 *
 * ## What is never on screen
 *
 * `hash_pid` and the PKCS#12 passphrase. The former appears only as a truncated digest, which is
 * also the form the stability check compares; the latter is a write-only field and the certificate
 * is written to a file on the server rather than offered as a download, because a download would
 * put a private key in the operator's `Downloads` folder.
 */

const verdictNotice = (verdict: StabilityVerdict): SafeHtml => {
  if (verdict === "stable") {
    return notice(
      "info",
      "The digests match: hash_pid survived re-issuance, so the login is recoverable from a " +
        "re-obtained PID. Record this in docs/certificate-intake-runbook.md — it is the open " +
        "question that section marks as unverified.",
    );
  }
  if (verdict === "changed") {
    return notice(
      "warn",
      "The digests differ: a re-issued PID produces a different registrant. The wallet " +
        "installation and the PID inside it are irreplaceable — losing them leaves the " +
        "registrations alive but unmanageable. Record this, and treat that device accordingly.",
    );
  }
  return html``;
};

export const registrationView = (options: {
  readonly baseUrl: string;
  readonly entityPath: string;
  readonly entityCheck?: EntityCheck;
  readonly entityError?: string;
  readonly hashPidDigest?: string;
  readonly previousDigest?: string;
  readonly verdict: StabilityVerdict;
  readonly steps: readonly StepStatus[];
  readonly certificates: readonly { readonly label: string; readonly path: string }[];
  readonly message?: SafeHtml;
}): SafeHtml => {
  const authenticated = options.hashPidDigest !== undefined;
  const chainComplete = options.steps.every((step) => step.done);
  const runnable = options.entityCheck?.runnable === true;

  return html`
    <h1>Registration session</h1>
    <p class="lead">
      Enrolment at the reference RP Registration Service, <code>${options.baseUrl}</code>. The
      service is explicitly non-production: everything it issues is TEST trust material.
    </p>
    ${options.message ?? html``}

    <section>
      <h2>1 · Authenticate</h2>
      <p>
        The service has no accounts. It authenticates by an OpenID4VP presentation of a PID, and the
        resulting session credential is what every later call carries. It is a secret, so only its
        digest is ever shown.
      </p>
      ${
        authenticated
          ? html`<dl class="kv">
              <dt>Session credential</dt>
              <dd><code>${options.hashPidDigest}</code> <span class="muted">(sha-256, truncated)</span></dd>
              ${
                options.previousDigest
                  ? html`<dt>Previous login</dt>
                      <dd><code>${options.previousDigest}</code></dd>`
                  : html``
              }
            </dl>`
          : html`<form method="post" action="/registration/login">
              <button type="submit">Start the login</button>
            </form>`
      }
    </section>

    <section>
      <h2>2 · Is the login recoverable?</h2>
      <p>
        Whether the session credential is stable across a <strong>re-issued</strong> PID for the same
        synthetic identity is recorded as unverified, and the whole risk of a registration turns on
        it. Answering it costs two logins either side of a re-issuance — and it is only safe
        <strong>now</strong>, before anything is registered. Afterwards, deleting the PID that holds
        the login would be unthinkable.
      </p>
      ${verdictNotice(options.verdict)}
      ${
        authenticated && options.verdict === "unknown"
          ? html`<ol class="steps">
                <li>Note the digest above.</li>
                <li>In the wallet, delete the PID and obtain another — the same test identity if you are offered the choice, because a fresh synthetic identity would tell you nothing about stability.</li>
                <li>Then authenticate again below and the two digests are compared.</li>
              </ol>
              <form method="post" action="/registration/login?reauthenticate=1">
                <button type="submit">Authenticate again, keeping the current digest for comparison</button>
              </form>`
          : html``
      }
    </section>

    <section>
      <h2>3 · The entity</h2>
      <p>
        Read from <code>${options.entityPath}</code>. Validated before anything is sent, because the
        service has no idempotency key and no route that amends a half-built registration: a field it
        rejects at step nine leaves eight entities behind that cannot be edited away.
      </p>
      ${options.entityError ? notice("error", options.entityError) : html``}
      ${
        options.entityCheck && options.entityCheck.problems.length > 0
          ? html`<table class="problems">
              <thead><tr><th>Field</th><th>Problem</th></tr></thead>
              <tbody>
                ${options.entityCheck.problems.map(
                  (problem) => html`<tr class="${problem.kind}">
                    <td><code>${problem.path}</code></td>
                    <td>${problem.message}</td>
                  </tr>`,
                )}
              </tbody>
            </table>`
          : html``
      }
      ${
        runnable && options.entityCheck?.problems.length === 0
          ? notice("info", "The entity file is complete and valid.")
          : html``
      }
    </section>

    <section>
      <h2>4 · The chain</h2>
      <p>
        Fourteen calls, each consuming identifiers minted by an earlier one. Already-recorded steps
        are skipped, so an interrupted session resumes rather than creating a second set of entities.
      </p>
      <table class="steps-table">
        <thead><tr><th>Step</th><th>Route</th><th>State</th></tr></thead>
        <tbody>
          ${options.steps.map(
            (step) => html`<tr class="${step.done ? "done" : "pending"}">
              <td>${step.label}</td>
              <td><code>${step.route}</code></td>
              <td>${step.done ? html`id ${step.ids.join(", ")}` : "pending"}</td>
            </tr>`,
          )}
        </tbody>
      </table>
      ${
        authenticated && runnable && !chainComplete
          ? html`<form method="post" action="/registration/run">
              <button type="submit">Run the remaining steps</button>
            </form>`
          : html``
      }
      ${!authenticated ? notice("warn", "Authenticate first.") : html``}
      ${
        authenticated && !runnable
          ? notice("warn", "Fix the entity file before running the chain.")
          : html``
      }
    </section>

    <section>
      <h2>5 · Certificates</h2>
      <p>
        One PKCS#12 access certificate, keyed by the Wallet Relying Party, and one registration
        certificate per intended use. The passphrase you choose here protects the private key and is
        not stored. The files are written on the server, mode 600 — not offered as a download, which
        would leave a private key in your <code>Downloads</code> folder.
      </p>
      ${
        options.certificates.length > 0
          ? html`<dl class="kv">
              ${options.certificates.map(
                (certificate) => html`<dt>${certificate.label}</dt>
                  <dd><code>${certificate.path}</code></dd>`,
              )}
            </dl>`
          : html``
      }
      ${
        chainComplete && authenticated
          ? html`<form method="post" action="/registration/certificate">
              <label>
                Passphrase for the PKCS#12
                <input type="password" name="passphrase" required minlength="12" autocomplete="new-password">
              </label>
              <button type="submit">Issue the certificates</button>
            </form>`
          : notice("info", "Available once the chain is complete.")
      }
    </section>

    <section>
      <h2>6 · What closes the blocker</h2>
      <p>
        Not this session. Blocker <strong>B1</strong> is closed by the chain check — whether the
        issued certificate chains to an anchor on the notified <code>WRPACProviders</code> list. Run
        it from a terminal, because it needs the passphrase and writes nothing:
      </p>
      <pre class="cmd">./scripts/verify-access-certificate-chain.sh &lt;the PKCS#12 above&gt;</pre>
      <p>
        Then record the matched anchor and the freshness line in
        <code>docs/reference-wallet-testing.md</code> §8.1.
      </p>
    </section>
  `;
};

/**
 * The login page: a QR, and a poll until the holder approves.
 *
 * The QR encodes a URL belonging to the EUDI verifier backend. The phone resolves it against that
 * backend directly — this console is never reached from the phone, which is why the whole flow
 * needs no public exposure and no tunnel.
 */
export const registrationLoginView = (options: {
  readonly qrValue: string;
  readonly presentationId: string;
  readonly reauthenticate: boolean;
}): SafeHtml => {
  const { svg, modules } = renderQr(options.qrValue, 6);
  return html`
    <h1>Scan with the wallet holding the test PID</h1>
    ${
      options.reauthenticate
        ? notice(
            "info",
            "This is the second login of the stability check. The previous digest has been kept " +
              "for comparison.",
          )
        : html``
    }
    <figure class="qr">
      <div class="qr-svg">${svg}</div>
      <figcaption>${modules}×${modules} modules</figcaption>
    </figure>
    <p class="muted">
      The code addresses the EUDI verifier backend, not this console. Approve the PID presentation in
      the wallet and this page will continue on its own.
    </p>
    <p id="registration-login-state" data-presentation-id="${options.presentationId}">
      Waiting for the presentation…
    </p>
    <form method="post" action="/registration/login/complete" id="registration-login-complete">
      <input type="hidden" name="presentationId" value="${options.presentationId}">
      <input type="hidden" name="reauthenticate" value="${options.reauthenticate ? "1" : ""}">
      <button type="submit">I have approved it — continue</button>
    </form>
    <p><a href="/registration">Abandon this login</a></p>
    <script src="/assets/registration.js" defer></script>
  `;
};

/**
 * Polling for the login page, kept separate from the console's own script so that neither grows a
 * dependency on the other's markup.
 */
export const REGISTRATION_JS = `"use strict";
(function () {
  var state = document.getElementById("registration-login-state");
  var form = document.getElementById("registration-login-complete");
  if (!state || !form) return;
  var id = state.getAttribute("data-presentation-id");
  if (!id) return;

  var attempts = 0;
  function poll() {
    attempts += 1;
    if (attempts > 100) {
      state.textContent = "Gave up waiting. Abandon this login and start another.";
      return;
    }
    fetch("/registration/login/" + encodeURIComponent(id) + "/status.json", {
      headers: { accept: "application/json" },
    })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (body) {
        if (body && body.presented) {
          state.textContent = "Presentation accepted. Continuing…";
          // Submitted rather than followed as a link: completing the login is a state change, and
          // it carries the SameSite=Strict session cookie the console uses instead of CSRF tokens.
          form.submit();
          return;
        }
        window.setTimeout(poll, 3000);
      })
      .catch(function () { window.setTimeout(poll, 3000); });
  }
  window.setTimeout(poll, 2000);
})();
`;
