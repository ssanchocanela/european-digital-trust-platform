import { escapeHtml as e, interactionChoice, OBSERVATIONS, page } from "./pages.js";

/**
 * Wallet test plans (ADR 0022). Every page states that it is not a conformance test, puts what the
 * cited requirement asks next to what was observed, and never grades: no verdict word appears.
 */
/**
 * The sentence every wallet-test page carries — the same as `@edtp/sandbox-domain`'s, which the
 * platform puts in every report; a unit test keeps the two identical.
 */
export const NOT_A_CONFORMANCE_TEST = "This is not a conformance test and certifies nothing.";

const DISCLAIMER = `<p class="muted"><strong>${e(NOT_A_CONFORMANCE_TEST)}</strong> The sandbox records what
happened with a declared wallet build against its own TEST trust domain; whoever reads it draws the conclusion.</p>`;

export interface PlanView {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly steps: readonly unknown[];
}

export interface PlanRunSummary {
  readonly id: string;
  readonly planId: string;
  readonly provider: string;
  readonly build: string;
  readonly platform: string;
  readonly createdAt: string;
}

export function walletTestsPage(input: {
  readonly orgId: string;
  readonly plans: readonly PlanView[];
  readonly runs: readonly PlanRunSummary[];
  readonly services: readonly {
    relyingPartyServiceId: string;
    serviceTradeName: string;
    role: string;
  }[];
  readonly error?: string;
}): string {
  const org = e(input.orgId);
  const runs = input.runs
    .map(
      (r) => `<tr><td><a href="/org/${org}/wallet-tests/${e(r.id)}">${e(r.planId)}</a></td>
<td>${e(r.provider)} · ${e(r.build)} · ${e(r.platform)}</td><td>${e(r.createdAt.slice(0, 16).replace("T", " "))}</td></tr>`,
    )
    .join("");
  const options = input.plans
    .map((p) => {
      const services = input.services.filter((s) => s.role === p.role);
      return services
        .map(
          (s) =>
            `<option value="${e(p.id)}|${e(s.relyingPartyServiceId)}">${e(p.title)} — on ${e(s.serviceTradeName)} (${p.steps.length} steps)</option>`,
        )
        .join("");
    })
    .join("");
  return page(
    "Wallet tests",
    `<h1>Wallet tests</h1>${DISCLAIMER}
<p>A plan takes one wallet build through a fixed list of the sandbox's defects, on your own hosted verifier or
issuer. For each step the sandbox shows what the cited requirement asks of a wallet, what the server observed,
and what you observed. It never grades the wallet.</p>
${input.error ? `<p role="alert"><strong>${e(input.error)}</strong></p>` : ""}
<h2>Plan runs</h2>
${runs ? `<div class="scroll"><table><tr><th>Plan</th><th>Wallet (as declared)</th><th>Started</th></tr>${runs}</table></div>` : "<p>None yet.</p>"}
<h2>Start a plan</h2>
${
  options
    ? `<form method="post" action="/org/${org}/wallet-tests">
<label for="plan">Plan and service</label><select id="plan" name="plan">${options}</select>
<label for="provider">Wallet provider</label><input id="provider" name="provider" required maxlength="200">
<label for="build">Wallet build (version, as the wallet shows it)</label><input id="build" name="build" required maxlength="200">
<label for="platform">Platform (e.g. Android 15, Pixel 8)</label><input id="platform" name="platform" required maxlength="100">
<p class="muted">Declared by you, and shown as declared: the sandbox does not check it.</p>
<button>Start the plan</button></form>`
    : "<p>Register a Relying Party service with an intended use, a PID Provider service, or an EAA Provider service, first.</p>"
}
<p><a href="/org/${org}">Back to the organisation</a></p>`,
    { signedIn: true },
  );
}

export interface ReportStep {
  readonly index: number;
  readonly title: string;
  readonly requirement: string;
  readonly asks: string;
  readonly checkRegistrationCertificates?: string;
  readonly started: boolean;
  readonly server?: string;
  readonly tester?: string;
  readonly note?: string;
  readonly observationsDisagree?: boolean;
}

export interface PlanReport {
  readonly planRun: string;
  readonly plan: { id: string; version: number; title: string };
  readonly wallet: { provider: string; build: string; platform: string };
  readonly createdAt: string;
  readonly steps: readonly ReportStep[];
}

const SERVER: Record<string, string> = {
  presented: "a presentation arrived (the wallet released data)",
  credential_collected:
    "the wallet collected the credential (whether it kept it, only you can say)",
  wallet_declined: "the wallet sent an explicit refusal",
  issuer_refused_wallet: "the issuer did not trust the wallet's attestation",
  no_presentation: "nothing arrived (not the same as a refusal)",
  no_collection: "nothing was collected (not the same as a refusal)",
  protocol_error: "the exchange broke; the server cannot say on which side",
  pending: "waiting",
};

export function planReportPage(orgId: string, report: PlanReport): string {
  const org = e(orgId);
  const rid = e(report.planRun);
  const rows = report.steps
    .map((s) => {
      const tester = OBSERVATIONS.find(([k]) => k === s.tester)?.[1] ?? s.tester;
      const observe = s.started
        ? `<form method="post" action="/org/${org}/wallet-tests/${rid}/steps/${s.index}/observation">
<select name="observation" aria-label="What the wallet showed">${OBSERVATIONS.map(([k, v]) => `<option value="${e(k)}"${k === s.tester ? " selected" : ""}>${e(v)}</option>`).join("")}</select>
<input name="note" maxlength="500" placeholder="Note (no credential values)" value="${e(s.note ?? "")}"><button class="secondary">Record</button></form>`
        : "";
      return `<tr><td>${e(s.index + 1)}</td><td><strong>${e(s.title)}</strong><br><small>${e(s.requirement)}</small>${
        s.checkRegistrationCertificates
          ? `<br><small>Set <em>Check Registration Certificates</em> <strong>${e(s.checkRegistrationCertificates)}</strong> first.</small>`
          : ""
      }</td><td>${e(s.asks)}</td><td>${s.server ? e(SERVER[s.server] ?? s.server) : "—"}</td>
<td>${tester ? e(tester) : "—"}${s.note ? `<br><small>${e(s.note)}</small>` : ""}${
        s.observationsDisagree ? `<br><strong>The two observations disagree.</strong>` : ""
      }${observe}</td>
<td><form method="post" action="/org/${org}/wallet-tests/${rid}/steps/${s.index}">${interactionChoice()}<button>${s.started ? "Run again" : "Run"}</button></form></td></tr>`;
    })
    .join("");
  return page(
    "Wallet test",
    `<h1>${e(report.plan.title)}</h1>
<p>Wallet, as declared: <strong>${e(report.wallet.provider)} · ${e(report.wallet.build)} · ${e(report.wallet.platform)}</strong></p>
${DISCLAIMER}
<div class="scroll"><table><tr><th>#</th><th>Step</th><th>What the cited requirement asks of a wallet</th><th>What the server observed</th><th>What you observed</th><th></th></tr>${rows}</table></div>
<p><a class="button" href="/org/${org}/wallet-tests/${rid}/report.jwt">Download the signed report</a>
<a href="/org/${org}/wallet-tests/${rid}/report.json">JSON</a></p>
<p class="muted">The signature shows the report came from this sandbox unchanged; it says nothing about the wallet.</p>
<p><a href="/org/${org}/wallet-tests">All plan runs</a></p>`,
    { signedIn: true },
  );
}
