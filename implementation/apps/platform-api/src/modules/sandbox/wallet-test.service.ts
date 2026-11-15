import { X509Certificate } from "node:crypto";
import type {
  SandboxCertificateRepository,
  SandboxWalletTestRepository,
  WalletTestRun,
} from "@edtp/persistence";
import {
  issuanceObservation,
  NOT_A_CONFORMANCE_TEST,
  presentationObservation,
  type ServerObservation,
} from "@edtp/sandbox-domain";
import {
  basicConstraints,
  issueCertificate,
  keyUsage,
  OID,
  randomSerial,
  signCompactJws,
  toPem,
} from "@edtp/sandbox-pki";
import { type Clock, type CorrelationId, newUuid, PlatformError } from "@edtp/shared";
import type { AuditService } from "../audit/audit.service.js";
import type { SandboxIssuerService } from "./issuer.service.js";
import type { SandboxService, SignedInContext } from "./sandbox.service.js";
import type { SandboxTrustDomain } from "./trust-domain.runtime.js";
import type { SandboxVerifierService } from "./verifier.service.js";
import { type PlanStep, planById, WALLET_TEST_PLANS } from "./wallet-test-plans.js";

/** The tester's observation, the same list as a single run's (specification §6). */
export const TESTER_OBSERVATIONS = [
  "refused_before_consent",
  "warned_user_stopped",
  "warned_user_continued",
  "presented_without_warning",
  "error_shown",
  "nothing_happened",
  "other",
] as const;

const REPORT_SIGNER = "report-signer";
const REPORT_SIGNER_CHANNEL = "certificate:report-signer";

/** Synthetic values for issuance steps: content the plan supplies, never a person's. */
const PLAN_PID = {
  givenName: "Plan",
  familyName: "Wallet-Test",
  birthdate: "1990-01-01",
  birthCountry: "ES",
  nationalities: ["ES"],
} as const;

const RELEASED: readonly ServerObservation[] = ["presented", "credential_collected"];
const TESTER_SAYS_STOPPED = new Set([
  "refused_before_consent",
  "warned_user_stopped",
  "error_shown",
  "nothing_happened",
]);
const TESTER_SAYS_RELEASED = new Set(["presented_without_warning", "warned_user_continued"]);

/**
 * Testing wallets (ADR 0022): a plan run takes one declared wallet build through a fixed list of the
 * sandbox's own runs, and reports, step by step, what the cited requirement asks next to what the
 * server observed and what the tester observed. It observes; it never grades (ADR 0022 §1).
 */
export class SandboxWalletTestService {
  constructor(
    private readonly sandbox: SandboxService,
    private readonly services: SandboxCertificateRepository,
    private readonly repository: SandboxWalletTestRepository,
    private readonly verifier: SandboxVerifierService | undefined,
    private readonly issuer: SandboxIssuerService | undefined,
    private readonly domain: SandboxTrustDomain,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  plans() {
    return WALLET_TEST_PLANS.map((p) => ({
      id: p.id,
      version: p.version,
      title: p.title,
      role: p.role,
      steps: p.steps.map((s, index) => ({ index, ...s })),
    }));
  }

  /** Writes need an active organisation; reading a report does not (a suspended one keeps its record). */
  private async planRun(
    context: SignedInContext,
    orgId: string,
    planRunId: string,
    write = true,
  ) {
    const membership = write
      ? await this.sandbox.activeMembershipIn(context, orgId)
      : this.sandbox.membershipIn(context, orgId);
    const run = await this.repository.run(membership.tenantId, planRunId);
    if (!run) throw PlatformError.notFound("Plan run");
    const plan = planById(run.planId);
    if (!plan || plan.version !== run.planVersion) throw PlatformError.notFound("Plan");
    return { run, plan };
  }

  async start(
    context: SignedInContext,
    orgId: string,
    serviceId: string,
    planId: string,
    declared: { provider: string; build: string; platform: string },
  ) {
    const membership = await this.sandbox.activeMembershipIn(context, orgId);
    const plan = planById(planId);
    if (!plan) throw PlatformError.notFound("Plan");
    const service = await this.services.service(membership.tenantId, serviceId);
    if (!service) throw PlatformError.notFound("Service");
    if (service.role !== plan.role) {
      throw PlatformError.conflict(
        "wallet_test_plan_not_for_this_service",
        plan.role === "pid_provider"
          ? "This plan runs on a PID Provider service."
          : "This plan runs on a Relying Party service.",
      );
    }
    const run: WalletTestRun = {
      id: newUuid(),
      tenantId: membership.tenantId,
      relyingPartyServiceId: serviceId,
      planId: plan.id,
      planVersion: plan.version,
      provider: declared.provider.trim().slice(0, 200),
      build: declared.build.trim().slice(0, 200),
      platform: declared.platform.trim().slice(0, 100),
      createdAt: this.clock.now(),
    };
    await this.repository.create(run);
    await this.audit.record({
      tenantId: membership.tenantId,
      actor: "sandbox",
      action: "sandbox.wallet_test.started",
      subjectType: "sandbox_wallet_test_run",
      subjectId: run.id,
    });
    return { id: run.id, planId: plan.id };
  }

  /**
   * Start a step: configure the participant's own hosted verifier or issuer with the step's variants,
   * then start the run or make the offer. A step started again replaces its earlier run.
   */
  async startStep(
    context: SignedInContext,
    orgId: string,
    planRunId: string,
    stepIndex: number,
    interaction: "SAME_DEVICE" | "QR",
    correlationId: CorrelationId,
  ) {
    const { run, plan } = await this.planRun(context, orgId, planRunId);
    const step = plan.steps[stepIndex];
    if (!step) throw PlatformError.notFound("Step");
    const serviceId = run.relyingPartyServiceId;
    if (step.kind === "verifier") {
      if (!this.verifier) throw PlatformError.notFound("Route");
      const membership = await this.sandbox.activeMembershipIn(context, orgId);
      const use = (await this.services.intendedUsesOf(membership.tenantId, serviceId))[0];
      if (!use) {
        throw PlatformError.conflict(
          "wallet_test_needs_intended_use",
          "Register an intended use on this service first.",
        );
      }
      await this.verifier.configure(context, orgId, serviceId, {
        accessVariant: step.accessVariant,
        uses: [{ intendedUseId: use.id, registrationVariant: step.registrationVariant }],
      });
      const started = await this.verifier.startRun(context, orgId, serviceId, {
        intendedUseId: use.id,
        interaction,
        correlationId,
      });
      await this.repository.startStep(run.id, stepIndex, started.runId, this.clock.now());
      return {
        stepIndex,
        kind: step.kind,
        walletUri: started.walletUri,
        expiresAt: started.expiresAt,
      };
    }
    if (!this.issuer) throw PlatformError.notFound("Route");
    await this.issuer.configure(context, orgId, serviceId, {
      signingVariant: step.signingVariant,
      registrationVariant: "RC-00",
    });
    const offer = await this.issuer.offer(context, orgId, serviceId, PLAN_PID);
    await this.repository.startStep(run.id, stepIndex, offer.id, this.clock.now());
    return {
      stepIndex,
      kind: step.kind,
      walletUri: offer.offerUri,
      expiresAt: offer.expiresAt,
    };
  }

  async observe(
    context: SignedInContext,
    orgId: string,
    planRunId: string,
    stepIndex: number,
    observation: string,
    note: string | undefined,
  ) {
    const { run } = await this.planRun(context, orgId, planRunId);
    if (!(TESTER_OBSERVATIONS as readonly string[]).includes(observation)) {
      throw PlatformError.validation(
        "invalid_observation",
        "Choose an observation from the list.",
      );
    }
    const cleaned =
      note
        // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed.
        ?.replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, 500) || undefined;
    if (
      !(await this.repository.observe(
        run.id,
        stepIndex,
        observation,
        cleaned,
        this.clock.now(),
      ))
    ) {
      throw PlatformError.conflict("wallet_test_step_not_started", "Start the step first.");
    }
  }

  /** What each step asked, what the server saw, what the tester saw (ADR 0022 §3–§4). */
  async report(
    context: SignedInContext,
    orgId: string,
    planRunId: string,
    correlationId: CorrelationId,
  ) {
    const { run, plan } = await this.planRun(context, orgId, planRunId, false);
    const started = new Map((await this.repository.steps(run.id)).map((s) => [s.stepIndex, s]));
    const steps = [];
    for (const [index, step] of plan.steps.entries()) {
      const s = started.get(index);
      const server = s
        ? await this.serverObservation(context, orgId, step, s.refId, correlationId)
        : undefined;
      const disagree =
        server !== undefined &&
        s?.observation !== undefined &&
        ((RELEASED.includes(server) && TESTER_SAYS_STOPPED.has(s.observation)) ||
          ((server === "no_presentation" || server === "no_collection") &&
            TESTER_SAYS_RELEASED.has(s.observation)));
      steps.push({
        index,
        title: step.title,
        requirement: step.requirement,
        asks: step.asks,
        ...(step.kind === "verifier"
          ? { checkRegistrationCertificates: step.checkRegistrationCertificates }
          : {}),
        started: Boolean(s),
        ...(server ? { server } : {}),
        ...(s?.observation ? { tester: s.observation } : {}),
        ...(s?.note ? { note: s.note } : {}),
        ...(disagree ? { observationsDisagree: true } : {}),
      });
    }
    return {
      planRun: run.id,
      plan: { id: plan.id, version: plan.version, title: plan.title },
      wallet: {
        provider: run.provider,
        build: run.build,
        platform: run.platform,
        declared: true,
      },
      createdAt: run.createdAt.toISOString(),
      statement: NOT_A_CONFORMANCE_TEST,
      steps,
    };
  }

  private async serverObservation(
    context: SignedInContext,
    orgId: string,
    step: PlanStep,
    refId: string,
    correlationId: CorrelationId,
  ): Promise<ServerObservation> {
    if (step.kind === "verifier") {
      if (!this.verifier) return "pending";
      const r = await this.verifier.run(context, orgId, refId, correlationId);
      return presentationObservation(r.outcome.status);
    }
    if (!this.issuer) return "pending";
    const i = await this.issuer.issuanceStatus(context, orgId, refId);
    return issuanceObservation(i.status);
  }

  /**
   * The report as a JWS under the sandbox's report-signing key (ADR 0022 §4). The signature says who
   * produced the report and that it is unchanged — not that the wallet is good; the payload says so.
   */
  async signedReport(
    context: SignedInContext,
    orgId: string,
    planRunId: string,
    correlationId: CorrelationId,
  ) {
    const report = await this.report(context, orgId, planRunId, correlationId);
    const { signer, certificate } = await this.reportSigner();
    return signCompactJws(
      { typ: "edtp-wallet-test-report+jwt", x5c: [certificate.toString("base64")] },
      { ...report, iat: Math.floor(this.clock.now().getTime() / 1000) },
      signer,
    );
  }

  /** The report-signing key, created in the sealed store at first use, and its certificate. */
  async reportSigner() {
    const existing = await this.services.latestPublication(REPORT_SIGNER_CHANNEL);
    if (existing && (await this.domain.hasKey(REPORT_SIGNER))) {
      return {
        signer: await this.domain.signer(REPORT_SIGNER),
        certificate: Buffer.from(existing.body, "base64"),
      };
    }
    const signer = (await this.domain.hasKey(REPORT_SIGNER))
      ? await this.domain.signer(REPORT_SIGNER)
      : await this.domain.createKey(REPORT_SIGNER);
    const name = [
      { type: OID.organizationName, value: "EDTP Sandbox - TEST ONLY" },
      { type: OID.commonName, value: "EDTP Sandbox Wallet Test Report Signer - TEST ONLY" },
    ];
    const now = this.clock.now();
    const notAfter = new Date(now.getTime() + 2 * 365 * 86_400_000);
    const der = issueCertificate(
      {
        serial: randomSerial(),
        issuer: name,
        subject: name,
        notBefore: now,
        notAfter,
        subjectPublicKey: signer.publicKey,
        extensions: [basicConstraints(false), keyUsage(["digitalSignature"])],
      },
      signer,
    );
    await this.services.publish(
      REPORT_SIGNER_CHANNEL,
      {
        sequence: (existing?.sequence ?? 0) + 1,
        issuedAt: now,
        nextUpdate: notAfter,
        body: der.toString("base64"),
        contentHash: new X509Certificate(der).fingerprint256,
      },
      newUuid(),
    );
    return { signer, certificate: der };
  }

  /** The published report-signer certificate, PEM, for anyone checking a report. */
  async reportSignerCertificate(): Promise<string> {
    return toPem((await this.reportSigner()).certificate, "CERTIFICATE");
  }

  async runs(context: SignedInContext, orgId: string) {
    const membership = this.sandbox.membershipIn(context, orgId);
    return (await this.repository.runs(membership.tenantId)).map((r) => ({
      id: r.id,
      planId: r.planId,
      serviceId: r.relyingPartyServiceId,
      provider: r.provider,
      build: r.build,
      platform: r.platform,
      createdAt: r.createdAt,
    }));
  }
}
