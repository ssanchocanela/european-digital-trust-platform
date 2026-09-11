import {
  applyResultPolicy,
  compilePresentationPolicy,
  type InteractionType,
  isTerminal,
  type NormalisedClaims,
  type PresentationState,
  type PresentationTransaction,
  resolvePublishedVersion,
  type TerminalState,
} from "@edtp/domain";
import type { EngineSessionHandle, EudiVerifierPort } from "@edtp/eudi-verifier-port";
import type {
  PolicyRepository,
  RegistrationRepository,
  TransactionRepository,
} from "@edtp/persistence";
import {
  asId,
  type Clock,
  type CorrelationId,
  newAuditEventId,
  newPresentationId,
  newWebhookDeliveryId,
  newWebhookEventId,
  PlatformError,
  type PresentationId,
  type PresentationPolicyId,
  type TenantId,
} from "@edtp/shared";
import type { Logger } from "../../logging/logger.js";
import type { WebhookService } from "../../webhook/webhook.service.js";
import type { AuditService } from "../audit/audit.service.js";

export interface CreatePresentationCommand {
  readonly tenantId: TenantId;
  readonly policyId: PresentationPolicyId;
  readonly policyVersion?: number;
  readonly businessReference: string;
  readonly callbackUrl?: string;
  readonly interactionType?: InteractionType;
  readonly correlationId: CorrelationId;
}

export interface PresentationView {
  readonly presentationId: PresentationId;
  readonly businessReference: string;
  readonly status: PresentationState;
  readonly policyId: PresentationPolicyId;
  readonly policyVersion: number;
  readonly interaction?: { readonly type: InteractionType; readonly uri: string };
  readonly expiresAt: Date;
  readonly result?: { readonly claims: NormalisedClaims };
  readonly failureCode?: string;
  readonly verifierSideFailure?: boolean;
  readonly sentWithoutRegistrationCertificate?: boolean;
}

/**
 * Orchestrates the presentation flow.
 *
 * Two properties of this class matter more than its shape:
 *
 * 1. **Content never escapes a call stack.** `disclosedClaims` is fetched from the port,
 *    passed straight to `applyResultPolicy`, and goes out of scope in the same method.
 *    It is never assigned to a field, put on a queue, written to a retry payload or
 *    logged — ARF `AS-RP-01-002` (`OIA_16`), ADR 0004.
 * 2. **Every state change goes through the domain transition table.** The engine reports
 *    a coarse status, so the platform walks the intermediate states explicitly rather
 *    than jumping to a terminal one. That keeps the audit trail honest about what was
 *    observed and keeps illegal transitions impossible.
 */
export class PresentationService {
  constructor(
    private readonly registration: RegistrationRepository,
    private readonly policies: PolicyRepository,
    private readonly transactions: TransactionRepository,
    private readonly verifier: EudiVerifierPort,
    private readonly audit: AuditService,
    private readonly webhooks: WebhookService,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly publicUrl: string,
  ) {}

  async create(command: CreatePresentationCommand): Promise<PresentationView> {
    const now = this.clock.now();
    const log = this.logger.child({
      correlationId: command.correlationId,
      tenantId: command.tenantId,
      policyId: command.policyId,
    });

    const policy = await this.policies.findPolicy(command.tenantId, command.policyId);
    if (!policy) throw PlatformError.notFound("Presentation policy");
    if (policy.status === "RETIRED") {
      throw PlatformError.conflict(
        "policy_retired",
        "The presentation policy has been retired and cannot be used.",
      );
    }

    // With no explicit version the latest published version is used; a draft is never
    // resolvable, because an unpublished policy has not been validated for use.
    const versions = await this.policies.listVersions(command.tenantId, command.policyId);
    const version = resolvePublishedVersion(versions, command.policyVersion);

    const context = await this.registration.loadCompilerContext(
      command.tenantId,
      policy.relyingPartyServiceId,
      policy.intendedUseId,
    );

    // Re-validates against the intended use, so a registration change after publication
    // cannot silently widen a request.
    const plan = compilePresentationPolicy({
      policyVersion: version,
      relyingParty: context.relyingParty,
      relyingPartyService: context.service,
      relyingPartyInstance: context.instance,
      intendedUse: context.intendedUse,
      ...(context.registrationCertificate
        ? { registrationCertificate: context.registrationCertificate }
        : {}),
      accessCertificate: context.accessCertificate,
      at: now,
    });

    const callbackUrl = command.callbackUrl
      ? this.resolveCallbackUrl(command.callbackUrl, context.service.callbackUrlAllowList)
      : undefined;

    const interactionType: InteractionType = command.interactionType ?? "SAME_DEVICE";
    const lifetime = version.retentionPolicy.transactionLifetimeSeconds;
    const presentationId = newPresentationId();

    const transaction: PresentationTransaction = {
      id: presentationId,
      tenantId: command.tenantId,
      relyingPartyServiceId: policy.relyingPartyServiceId,
      policyId: policy.id,
      policyVersion: version.version,
      businessReference: command.businessReference,
      state: "CREATED",
      interactionType,
      deliveryStatus: callbackUrl ? "PENDING" : "NOT_REQUIRED",
      ...(callbackUrl ? { callbackUrl } : {}),
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + lifetime * 1000),
    };
    await this.transactions.create(transaction);

    if (interactionType === "QR") {
      // ARF `EW-PIO-01-016` (`OIA_08c`) says Wallet Units SHOULD NOT support
      // redirect-based cross-device flows, and `EW-PIO-01-017` (`OIA_08d`) obliges a
      // Relying Party that uses one to implement mitigations, which V0 has not. The use
      // is audited so it is visible rather than silent — ADR 0005 Decision 6.
      await this.audit.record({
        tenantId: command.tenantId,
        actor: "tenant",
        action: "platform.interaction.cross_device_requested",
        subjectType: "presentation",
        subjectId: presentationId,
        policyId: policy.id,
        policyVersion: version.version,
        correlationId: command.correlationId,
      });
    }

    let created: Awaited<ReturnType<EudiVerifierPort["createPresentationRequest"]>>;
    try {
      created = await this.verifier.createPresentationRequest({
        plan,
        interactionType,
        // The wallet returns the user here after a same-device flow. It is the platform's
        // own public URL, never a customer-supplied value, so it cannot be used to
        // redirect a user off-platform.
        returnUrl: `${this.publicUrl}/v1/presentations/${presentationId}/return`,
        sessionTtlSeconds: lifetime,
      });
    } catch (error) {
      await this.transactions.transition(
        command.tenantId,
        presentationId,
        "CREATED",
        "PROTOCOL_ERROR",
        "engine rejected the presentation request",
        this.clock.now(),
        { failureCode: error instanceof PlatformError ? error.code : "engine_error" },
      );
      log.warn("presentation request could not be created", {
        presentationId,
        failureCode: error instanceof PlatformError ? error.code : "engine_error",
      });
      throw error;
    }

    await this.transactions.attachEngineSession(
      command.tenantId,
      presentationId,
      created.session,
      created.sentWithoutRegistrationCertificate,
      this.clock.now(),
    );
    await this.transactions.transition(
      command.tenantId,
      presentationId,
      "CREATED",
      "REQUEST_READY",
      "engine created the presentation request",
      this.clock.now(),
    );
    await this.transactions.transition(
      command.tenantId,
      presentationId,
      "REQUEST_READY",
      "AWAITING_WALLET",
      "interaction URI issued to the business client",
      this.clock.now(),
    );

    if (created.sentWithoutRegistrationCertificate) {
      // `EW-DM-44-023` (`RPRC_19`) requires a single applicable registration certificate
      // in every presentation request, by value. V0 has no reachable provider (blocker
      // B3). The omission is recorded, never hidden.
      log.warn("presentation request sent without a registration certificate", {
        presentationId,
        reason: "no registration certificate is available for this intended use",
      });
    }

    await this.audit.record({
      tenantId: command.tenantId,
      actor: "tenant",
      action: "presentation.created",
      subjectType: "presentation",
      subjectId: presentationId,
      policyId: policy.id,
      policyVersion: version.version,
      outcome: "AWAITING_WALLET",
      correlationId: command.correlationId,
      detail: {
        interactionType,
        businessReference: command.businessReference,
        sentWithoutRegistrationCertificate: created.sentWithoutRegistrationCertificate,
      },
    });

    log.info("presentation created", { presentationId, interactionType });

    return {
      presentationId,
      businessReference: command.businessReference,
      status: "AWAITING_WALLET",
      policyId: policy.id,
      policyVersion: version.version,
      interaction: created.interaction,
      expiresAt: transaction.expiresAt,
      sentWithoutRegistrationCertificate: created.sentWithoutRegistrationCertificate,
    };
  }

  /**
   * Reads a presentation, advancing it if the engine has moved on.
   *
   * Polling is the V0 default result path: the engine's outbound webhook carries the
   * disclosed claims under static-credential authentication only, with no signature,
   * timestamp or event id, so polling avoids that inbound hop entirely
   * (ADR 0002 Decision 5).
   */
  async get(
    tenantId: TenantId,
    presentationId: PresentationId,
    correlationId: CorrelationId,
  ): Promise<PresentationView> {
    const tx = await this.transactions.find(tenantId, presentationId);
    if (!tx) throw PlatformError.notFound("Presentation");

    const current = isTerminal(tx.state) ? tx : await this.advance(tx, correlationId);
    const result =
      current.state === "VERIFIED"
        ? await this.transactions.findResult(tenantId, presentationId)
        : undefined;

    return {
      presentationId: current.id,
      businessReference: current.businessReference,
      status: current.state,
      policyId: current.policyId,
      policyVersion: current.policyVersion,
      expiresAt: current.expiresAt,
      ...(result ? { result: { claims: result.claims } } : {}),
      ...(current.failureCode ? { failureCode: current.failureCode } : {}),
    };
  }

  async cancel(
    tenantId: TenantId,
    presentationId: PresentationId,
    correlationId: CorrelationId,
  ): Promise<PresentationView> {
    const tx = await this.transactions.find(tenantId, presentationId);
    if (!tx) throw PlatformError.notFound("Presentation");
    if (isTerminal(tx.state)) {
      throw PlatformError.conflict(
        "presentation_already_settled",
        `The presentation has already settled as ${tx.state} and cannot be cancelled.`,
      );
    }

    const session = await this.transactions.findEngineSession(tenantId, presentationId);
    if (session) {
      try {
        await this.verifier.cancelPresentation(this.toHandle(session));
      } catch (error) {
        // A failure to cancel engine-side must not block the platform-side cancellation:
        // the engine session expires on its own TTL, and leaving the platform transaction
        // open would be worse than an orphaned engine session.
        this.logger.warn("engine session could not be cancelled", {
          correlationId,
          presentationId,
          failureCode: error instanceof PlatformError ? error.code : "engine_error",
        });
      }
    }

    await this.transactions.transition(
      tenantId,
      presentationId,
      tx.state,
      "CANCELLED",
      "cancelled by the business client",
      this.clock.now(),
    );
    await this.audit.record({
      tenantId,
      actor: "tenant",
      action: "presentation.cancelled",
      subjectType: "presentation",
      subjectId: presentationId,
      policyId: tx.policyId,
      policyVersion: tx.policyVersion,
      outcome: "CANCELLED",
      correlationId,
    });

    return this.get(tenantId, presentationId, correlationId);
  }

  /**
   * Advances a non-terminal transaction by asking the engine where it is.
   *
   * Expiry is checked first and locally: a transaction past its lifetime is `EXPIRED`
   * whatever the engine says, because the lifetime is the platform's promise to the
   * customer.
   */
  async advance(
    tx: PresentationTransaction,
    correlationId: CorrelationId,
  ): Promise<PresentationTransaction> {
    const now = this.clock.now();

    if (tx.expiresAt.getTime() <= now.getTime()) {
      return this.settle(tx, "EXPIRED", "the transaction lifetime elapsed", correlationId);
    }

    const session = await this.transactions.findEngineSession(tx.tenantId, tx.id);
    if (!session) return tx;

    const status = await this.verifier.getPresentationStatus(this.toHandle(session));
    if (status.progress !== "SETTLED" || !status.outcome) return tx;

    if (status.outcome !== "VERIFIED") {
      return this.settle(
        tx,
        status.outcome,
        status.failureMessage ?? `engine settled as ${status.outcome}`,
        correlationId,
        status.failureCode,
        status.verifierSideFailure,
      );
    }

    // Verified by the engine. Fetch the content, apply the result policy and discard the
    // content — all within this method.
    return this.settleVerified(tx, session, correlationId);
  }

  private async settleVerified(
    tx: PresentationTransaction,
    session: { readonly ref: string; readonly engineTenantRef: string },
    correlationId: CorrelationId,
  ): Promise<PresentationTransaction> {
    const versions = await this.policies.listVersions(tx.tenantId, tx.policyId);
    const version = versions.find((v) => v.version === tx.policyVersion);
    if (!version) {
      // The transaction snapshots the version number, so a missing version means the
      // configuration was deleted underneath it. That is a platform fault, not a
      // verification failure.
      throw PlatformError.internal(
        "policy_version_missing",
        "The policy version this presentation used no longer exists.",
      );
    }

    const payload = await this.verifier.processPresentationResult(this.toHandle(session));
    if (!payload.disclosedClaims) {
      return this.settle(
        tx,
        "PROTOCOL_ERROR",
        "the engine reported a verified presentation with no disclosed claims",
        correlationId,
        "engine_missing_claims",
      );
    }

    // The only place disclosed content is read. It is not assigned anywhere, and it goes
    // out of scope when this method returns.
    const outcome = applyResultPolicy(
      version.resultPolicy,
      payload.disclosedClaims,
      this.clock.now(),
    );

    if (!outcome.satisfied) {
      const settled = await this.settle(
        tx,
        "POLICY_NOT_SATISFIED",
        // The reasons name claim paths, never claim values.
        outcome.unsatisfiedReasons.join(" "),
        correlationId,
      );
      return settled;
    }

    const now = this.clock.now();
    await this.transactions.saveResult({
      presentationId: tx.id,
      tenantId: tx.tenantId,
      claims: outcome.claims,
      createdAt: now,
      purgeAfter: new Date(
        now.getTime() + version.retentionPolicy.resultRetentionSeconds * 1000,
      ),
    });

    return this.settle(
      tx,
      "VERIFIED",
      "presentation verified and policy satisfied",
      correlationId,
    );
  }

  /** Walks the intermediate states and records the terminal outcome. */
  private async settle(
    tx: PresentationTransaction,
    outcome: TerminalState,
    reason: string,
    correlationId: CorrelationId,
    failureCode?: string,
    verifierSideFailure?: boolean,
  ): Promise<PresentationTransaction> {
    const now = this.clock.now();
    let state: PresentationState = tx.state;

    // `EXPIRED` and `CANCELLED` are reachable directly. The verification outcomes are
    // only reachable from `VERIFYING`, so the platform records the intermediate states it
    // inferred rather than jumping the state machine.
    if (outcome !== "EXPIRED" && outcome !== "CANCELLED" && outcome !== "DECLINED_BY_USER") {
      if (state === "AWAITING_WALLET") {
        await this.transactions.transition(
          tx.tenantId,
          tx.id,
          state,
          "PRESENTATION_RECEIVED",
          "engine reported a wallet response",
          now,
        );
        state = "PRESENTATION_RECEIVED";
      }
      if (state === "PRESENTATION_RECEIVED") {
        await this.transactions.transition(
          tx.tenantId,
          tx.id,
          state,
          "VERIFYING",
          "engine verification in progress",
          now,
        );
        state = "VERIFYING";
      }
    }

    await this.transactions.transition(tx.tenantId, tx.id, state, outcome, reason, now, {
      ...(failureCode ? { failureCode } : {}),
    });

    await this.audit.record({
      tenantId: tx.tenantId,
      actor: "platform",
      action: "presentation.settled",
      subjectType: "presentation",
      subjectId: tx.id,
      policyId: tx.policyId,
      policyVersion: tx.policyVersion,
      outcome,
      correlationId,
      detail: {
        ...(failureCode ? { failureCode } : {}),
        ...(verifierSideFailure ? { verifierSideFailure: true } : {}),
        reason,
      },
    });

    if (verifierSideFailure) {
      // The engine documents `trust_list_unavailable` as a verifier-side misconfiguration
      // or outage rather than a defect in the presented credential, so it is logged as
      // our operational failure and must not be reported to the customer as a bad
      // credential.
      this.logger.error("verifier-side trust failure", {
        correlationId,
        presentationId: tx.id,
        failureCode,
      });
    }

    const settled = await this.transactions.find(tx.tenantId, tx.id);
    if (!settled) throw PlatformError.internal("transaction_vanished");

    if (settled.callbackUrl) {
      const result =
        outcome === "VERIFIED"
          ? await this.transactions.findResult(tx.tenantId, tx.id)
          : undefined;
      await this.webhooks.enqueueResult({
        transaction: settled,
        eventId: newWebhookEventId(),
        deliveryId: newWebhookDeliveryId(),
        claims: result?.claims,
        at: now,
      });
    }

    return settled;
  }

  /**
   * Resolves a requested callback URL against the Relying Party Service allow-list.
   *
   * An arbitrary per-request URL is refused. Without this, a caller could point the
   * platform's outbound request at an internal address and use the platform as an SSRF
   * proxy; the allow-list is registered out of band on the Service, so the set of
   * reachable hosts is configuration rather than input.
   */
  private resolveCallbackUrl(requested: string, allowList: readonly string[]): string {
    let parsed: URL;
    try {
      parsed = new URL(requested);
    } catch {
      throw PlatformError.validation(
        "invalid_callback_url",
        "The callback URL is not a valid URL.",
      );
    }
    if (parsed.protocol !== "https:") {
      throw PlatformError.validation(
        "callback_url_not_https",
        "A callback URL must use HTTPS.",
      );
    }
    // Exact match against a registered URL. Prefix matching would let a registered
    // `https://host/hook` authorise `https://host/hook/../../internal`.
    if (!allowList.includes(requested)) {
      throw PlatformError.forbidden(
        "callback_url_not_allowed",
        "The callback URL is not registered on this Relying Party Service.",
      );
    }
    return requested;
  }

  private toHandle(session: {
    readonly ref: string;
    readonly engineTenantRef: string;
  }): EngineSessionHandle {
    return {
      ref: asId<"EngineSessionRef">(session.ref),
      engineTenantRef: session.engineTenantRef,
    };
  }

  /** Used by the expiry job. */
  async expireDue(correlationId: CorrelationId): Promise<number> {
    const due = await this.transactions.findExpirable(this.clock.now());
    let expired = 0;
    for (const tx of due) {
      if (isTerminal(tx.state)) continue;
      try {
        await this.settle(tx, "EXPIRED", "the transaction lifetime elapsed", correlationId);
        expired += 1;
      } catch (error) {
        // A concurrent poller may have settled it first; that is not an error.
        if (error instanceof PlatformError && error.code === "transaction_state_changed")
          continue;
        this.logger.error("expiry failed", {
          correlationId,
          presentationId: tx.id,
          failureCode: error instanceof PlatformError ? error.code : "unknown",
        });
      }
    }
    return expired;
  }

  /** Audit-event id helper kept here so the service owns its own identifiers. */
  protected newAuditId() {
    return newAuditEventId();
  }
}
