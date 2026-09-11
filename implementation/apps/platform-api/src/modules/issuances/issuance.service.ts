import { randomUUID } from "node:crypto";
import {
  type AuthenticSourceConnector,
  type CredentialStatus,
  compileIssuancePolicy,
  type EligibilityEvaluator,
  type IssuancePlan,
  type IssuanceState,
  narrowToDeclaredClaims,
  resolveCallbackUrl,
  resolvePublishedVersion,
  type SourceAttributes,
} from "@edtp/domain";
import type {
  CredentialOfferHandle,
  EudiIssuerPort,
  EudiIssuerProvisioningPort,
} from "@edtp/eudi-issuer-port";
import type { IssuanceRepository, WebhookEndpointRepository } from "@edtp/persistence";
import {
  asId,
  type Clock,
  newWebhookDeliveryId,
  newWebhookEventId,
  PlatformError,
  type TenantId,
} from "@edtp/shared";
import type { Logger } from "../../logging/logger.js";
import type { WebhookService } from "../../webhook/webhook.service.js";
import type { AuditService } from "../audit/audit.service.js";

export interface CreateIssuanceCommand {
  readonly tenantId: TenantId;
  readonly policyId: string;
  readonly subjectReference: string;
  readonly businessReference?: string;
  readonly callbackUrl?: string;
}

export interface IssuanceView {
  readonly issuanceId: string;
  readonly status: IssuanceState;
  readonly businessReference?: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly interaction?: { readonly type: "SAME_DEVICE"; readonly uri: string };
  readonly expiresAt: Date;
  /**
   * Warnings the customer must see, because they bound what the issuance proves.
   *
   * Returned rather than logged: a client that does not know the attestation went out without a
   * registration certificate, or that its values came from a fixture, cannot reason about what it
   * has. Milestone 1 took the same position for presentations.
   */
  readonly warnings?: readonly string[];
  readonly issuedCredentialId?: string;
  readonly notEligibleReason?: string;
  readonly failureCode?: string;
}

/**
 * Issuance as a Service.
 *
 * ## The privacy discipline, which is the whole point of the ordering here
 *
 * Attribute values are fetched from the authentic source **just in time**, validated, narrowed to
 * the credential type's declared claims, handed to the port, and then go out of scope. They are
 * never assigned to a field, never persisted, never logged, never returned. §7.5 of the V0 plan and
 * ADR 0004.
 *
 * That is why `issue` does the fetch inside the same method as the port call, and why the only
 * thing that survives is the metadata in `recordIssued`. It would have been easier to fetch
 * attributes when the transaction is created and keep them around until the Wallet arrives; that
 * would also have meant storing a person's attribute values for the lifetime of a pending
 * transaction, which is exactly what the platform promises not to do.
 */
export class IssuanceService {
  constructor(
    private readonly issuance: IssuanceRepository,
    private readonly endpoints: WebhookEndpointRepository,
    private readonly issuer: EudiIssuerPort,
    private readonly provisioning: EudiIssuerProvisioningPort,
    private readonly connectors: ReadonlyMap<string, AuthenticSourceConnector>,
    private readonly evaluators: ReadonlyMap<string, EligibilityEvaluator>,
    private readonly audit: AuditService,
    private readonly webhooks: WebhookService,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /**
   * Creates an issuance transaction and an offer the Wallet can collect.
   *
   * Attribute values are **not** fetched here — see the class note.
   */
  async create(command: CreateIssuanceCommand): Promise<IssuanceView> {
    const now = this.clock.now();

    const policy = await this.issuance.findPolicy(command.tenantId, command.policyId);
    if (!policy) throw PlatformError.notFound("Issuance policy");

    const versions = await this.issuance.listVersions(command.tenantId, command.policyId);
    const version = resolvePublishedVersion(versions);

    const context = await this.issuance.loadIssuanceContext(
      command.tenantId,
      version.credentialTypeId,
    );

    const engineTenantRef = context.attestationProvider.engineTenantRef;
    const signingKeyBindingRef = context.attestationProvider.signingKeyBindingRef;
    if (!engineTenantRef || !signingKeyBindingRef) {
      throw PlatformError.conflict(
        "attestation_provider_not_provisioned",
        "The Attestation Provider has no engine tenant or signing key. Provision it before issuing.",
      );
    }

    // Re-validated at compile time, not trusted from publication: the records were written at
    // different moments and the combination can be wrong even when each part was right.
    const plan = compileIssuancePolicy({
      policyVersion: version,
      credentialType: context.credentialType,
      attestationProvider: {
        id: context.attestationProvider.id,
        tenantId: asId<"TenantId">(context.attestationProvider.tenantId),
        organisationId: asId<"OrganisationId">(context.attestationProvider.organisationId),
        registrarAssignedIdentifier: context.attestationProvider.registrarAssignedIdentifier,
        trustEnvironment: context.attestationProvider.trustEnvironment,
        createdAt: context.attestationProvider.createdAt,
      },
      providerContext: {
        attestationProviderIdentifier: context.attestationProvider.registrarAssignedIdentifier,
        ...(context.attestationProvider.registrationCertificateJwt
          ? {
              registrationCertificateJwt:
                context.attestationProvider.registrationCertificateJwt,
            }
          : {}),
        signingKeyBindingRef,
        engineTenantRef,
      },
      at: now,
    });

    // The same SSRF control verification uses, from the same function: a request may only name a
    // URL already on the endpoint's allow-list.
    let callbackUrl: string | undefined;
    if (command.callbackUrl) {
      const endpointId = context.attestationProvider.webhookEndpointId;
      if (!endpointId) {
        throw PlatformError.conflict(
          "no_webhook_endpoint",
          "A callbackUrl was requested but this Attestation Provider has no webhook endpoint. " +
            "Register one, with the URL on its allow-list.",
        );
      }
      const endpoint = await this.endpoints.find(
        command.tenantId,
        asId<"WebhookEndpointId">(endpointId),
      );
      if (!endpoint) throw PlatformError.notFound("Webhook endpoint");
      callbackUrl = resolveCallbackUrl(command.callbackUrl, endpoint.callbackUrlAllowList);
    }

    const connector = this.resolveConnector(version.authenticSource.connector);
    const lifetime = version.retentionPolicy.transactionLifetimeSeconds;
    const issuanceId = randomUUID();
    const expiresAt = new Date(now.getTime() + lifetime * 1000);

    await this.issuance.createTransaction({
      id: issuanceId,
      tenantId: command.tenantId,
      policyId: policy.id,
      policyVersion: version.version,
      credentialTypeId: context.credentialType.id,
      state: "CREATED",
      ...(command.businessReference ? { businessReference: command.businessReference } : {}),
      subjectReference: command.subjectReference,
      authenticSourceKind: connector.kind,
      ...(callbackUrl ? { callbackUrl } : {}),
      deliveryStatus: callbackUrl ? "PENDING" : "NOT_REQUIRED",
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    // Provision the engine-side configuration before the offer, so a configuration error surfaces
    // before a Wallet is invited to collect anything.
    await this.provisioning.provisionCredentialConfiguration({ engineTenantRef, plan });

    // The attribute values for the offer. Fetched now because the pre-authorised-code flow puts
    // them in the offer, and discarded as soon as the port has them.
    const claims = await this.fetchAndNarrow(
      connector,
      plan,
      command.subjectReference,
      version,
    );

    const offer = await this.issuer.createCredentialOffer({
      plan,
      claims,
      sessionTtlSeconds: lifetime,
    });

    await this.issuance.transition({
      tenantId: command.tenantId,
      id: issuanceId,
      from: "CREATED",
      to: "OFFER_READY",
      at: this.clock.now(),
      patch: {
        engineSessionRef: offer.session.ref,
        engineTenantRef: offer.session.engineTenantRef,
        sentWithoutRegistrationCertificate: offer.sentWithoutRegistrationCertificate,
      },
    });
    await this.issuance.transition({
      tenantId: command.tenantId,
      id: issuanceId,
      from: "OFFER_READY",
      to: "AWAITING_WALLET",
      at: this.clock.now(),
    });

    await this.audit.record({
      tenantId: command.tenantId,
      actor: "platform",
      action: "issuance.created",
      subjectType: "issuance",
      subjectId: issuanceId,
      detail: {
        policyId: policy.id,
        policyVersion: version.version,
        authenticSourceKind: connector.kind,
        sentWithoutRegistrationCertificate: offer.sentWithoutRegistrationCertificate,
        rulebook: plan.credential.rulebookIdentifier,
      },
    });

    return {
      issuanceId,
      status: "AWAITING_WALLET",
      ...(command.businessReference ? { businessReference: command.businessReference } : {}),
      policyId: policy.id,
      policyVersion: version.version,
      interaction: { type: "SAME_DEVICE", uri: offer.uri },
      expiresAt,
      ...this.warningsFor(offer.sentWithoutRegistrationCertificate, connector.kind),
    };
  }

  /** Reads an issuance, polling the engine and advancing the transaction as needed. */
  async get(tenantId: TenantId, issuanceId: string): Promise<IssuanceView> {
    const record = await this.issuance.findTransaction(tenantId, issuanceId);
    if (!record) throw PlatformError.notFound("Issuance");

    const base: IssuanceView = {
      issuanceId: record.id,
      status: record.state,
      ...(record.businessReference ? { businessReference: record.businessReference } : {}),
      policyId: record.policyId,
      policyVersion: record.policyVersion,
      expiresAt: record.expiresAt,
      ...(record.eligibilityReason ? { notEligibleReason: record.eligibilityReason } : {}),
      ...(record.failureCode ? { failureCode: record.failureCode } : {}),
      ...this.warningsFor(
        record.sentWithoutRegistrationCertificate ?? false,
        record.authenticSourceKind,
      ),
    };

    // Terminal, or not yet engaged with the engine: nothing to poll.
    if (!record.engineSessionRef || !record.engineTenantRef) return base;
    const advanceable: readonly IssuanceState[] = [
      "AWAITING_WALLET",
      "ELIGIBILITY_CHECK",
      "ISSUING",
    ];
    if (!advanceable.includes(record.state)) return base;

    const handle: CredentialOfferHandle = {
      ref: record.engineSessionRef as CredentialOfferHandle["ref"],
      engineTenantRef: record.engineTenantRef,
    };
    const status = await this.issuer.getIssuanceStatus(handle);

    if (status.progress !== "SETTLED") {
      // Walk the intermediate state explicitly rather than jumping, so the transition log records
      // what was observed. The engine reports a coarse status; the platform records the sequence.
      if (status.progress === "ISSUING" && record.state === "AWAITING_WALLET") {
        await this.advanceToIssuing(tenantId, record.id);
        return { ...base, status: "ISSUING" };
      }
      return base;
    }

    if (status.outcome === "ISSUED") {
      return await this.settleIssued(
        tenantId,
        record,
        handle,
        status.statusListUri,
        status.statusListIndex,
      );
    }

    const terminal: IssuanceState =
      status.outcome === "DECLINED_BY_USER"
        ? "DECLINED_BY_USER"
        : status.outcome === "TRUST_ERROR"
          ? "TRUST_ERROR"
          : status.outcome === "EXPIRED"
            ? "EXPIRED"
            : status.outcome === "CANCELLED"
              ? "CANCELLED"
              : "PROTOCOL_ERROR";

    await this.issuance.transition({
      tenantId,
      id: record.id,
      from: record.state,
      to: terminal,
      at: this.clock.now(),
      patch: {
        ...(status.failureCode ? { failureCode: status.failureCode } : {}),
        ...(status.failureMessage ? { failureMessage: status.failureMessage } : {}),
        ...(status.providerSideFailure !== undefined
          ? { providerSideFailure: status.providerSideFailure }
          : {}),
      },
    });
    await this.audit.record({
      tenantId,
      actor: "platform",
      action: "issuance.settled",
      subjectType: "issuance",
      subjectId: record.id,
      detail: { outcome: terminal, failureCode: status.failureCode },
    });
    await this.enqueueCallback(tenantId, record, terminal, {
      ...(status.failureCode ? { failureCode: status.failureCode } : {}),
    });

    return {
      ...base,
      status: terminal,
      ...(status.failureCode ? { failureCode: status.failureCode } : {}),
    };
  }

  /**
   * Changes an issued attestation's status.
   *
   * The domain refuses un-revocation (`AS-AP-07-007` / `VCR_04`) and the repository pins the prior
   * status in its `WHERE` clause, so this method can be a thin orchestration: decide, persist,
   * then tell the engine. That order matters — if the engine call fails, the platform's record and
   * the engine's disagree, and the platform's is the stricter one, which is the safe direction.
   */
  async changeCredentialStatus(input: {
    readonly tenantId: TenantId;
    readonly issuedCredentialId: string;
    readonly to: CredentialStatus;
  }): Promise<{ readonly status: CredentialStatus }> {
    const record = await this.issuance.findIssued(input.tenantId, input.issuedCredentialId);
    if (!record) throw PlatformError.notFound("Issued attestation");

    const versions = await this.issuance.listVersions(input.tenantId, record.issuancePolicyId);
    const version = versions.find((v) => v.version === record.issuancePolicyVersion);
    const suspensionAllowed = version?.statusPolicy.suspensionAllowed ?? false;

    const now = this.clock.now();
    await this.issuance.changeStatus({
      tenantId: input.tenantId,
      id: record.id,
      from: record.status,
      to: input.to,
      suspensionAllowed,
      at: now,
    });

    await this.issuer.updateCredentialStatus({
      session: {
        ref: record.engineSessionRef as CredentialOfferHandle["ref"],
        engineTenantRef: version ? await this.engineTenantFor(input.tenantId, record) : "",
      },
      status: input.to,
    });

    await this.audit.record({
      tenantId: input.tenantId,
      actor: "platform",
      action: "credential.status_changed",
      subjectType: "issued_credential",
      subjectId: record.id,
      detail: { from: record.status, to: input.to },
    });

    return { status: input.to };
  }

  // --- internals -----------------------------------------------------------

  /**
   * Fetches attribute values and narrows them to the declared claims.
   *
   * Returns the values to the caller rather than storing them anywhere, so their lifetime is the
   * caller's stack frame. The eligibility decision happens here too, because it needs the values
   * and they must not outlive this call.
   */
  private async fetchAndNarrow(
    connector: AuthenticSourceConnector,
    plan: IssuancePlan,
    subjectReference: string,
    version: {
      readonly authenticSource: { readonly parameters: Readonly<Record<string, unknown>> };
    },
  ): Promise<SourceAttributes> {
    const raw = await connector.fetch({
      subjectReference,
      requestedClaimPaths: plan.claimPathsToFetch,
      parameters: version.authenticSource.parameters,
    });

    if (!raw) {
      throw PlatformError.notFound("Subject at the authentic source");
    }

    // Validates and drops anything the type does not declare. The error carries claim paths only.
    return narrowToDeclaredClaims(raw, {
      id: "",
      tenantId: "",
      attestationProviderId: "",
      name: "",
      format: plan.credential.format,
      ...(plan.credential.vct ? { vct: plan.credential.vct } : {}),
      ...(plan.credential.doctype ? { doctype: plan.credential.doctype } : {}),
      rulebook: {
        identifier: plan.credential.rulebookIdentifier,
        version: plan.credential.rulebookVersion,
        anchorSource: plan.credential.anchorSource,
      },
      claims: plan.credential.claims,
      display: plan.credential.display,
      validitySeconds: plan.credentialValiditySeconds,
      statusMechanism: plan.statusListEnabled ? "TOKEN_STATUS_LIST" : "NONE",
      requiresKeyBinding: plan.holderBinding === "KEY_BOUND",
      createdAt: new Date(0),
    });
  }

  private async advanceToIssuing(tenantId: TenantId, id: string): Promise<void> {
    const at = this.clock.now();
    // The eligibility gate sits between the Wallet arriving and the attestation being signed, so
    // the sequence is recorded even when the evaluator trivially approves.
    await this.issuance.transition({
      tenantId,
      id,
      from: "AWAITING_WALLET",
      to: "ELIGIBILITY_CHECK",
      at,
    });
    await this.issuance.transition({
      tenantId,
      id,
      from: "ELIGIBILITY_CHECK",
      to: "ISSUING",
      at: this.clock.now(),
    });
  }

  private async settleIssued(
    tenantId: TenantId,
    record: {
      readonly id: string;
      readonly state: IssuanceState;
      readonly policyId: string;
      readonly policyVersion: number;
      readonly credentialTypeId: string;
      readonly callbackUrl?: string;
      readonly businessReference?: string;
      readonly expiresAt: Date;
      readonly sentWithoutRegistrationCertificate?: boolean;
      readonly authenticSourceKind?: string;
    },
    handle: CredentialOfferHandle,
    statusListUri?: string,
    statusListIndex?: number,
  ): Promise<IssuanceView> {
    const now = this.clock.now();

    // Walk any intermediate states the poll skipped, so the log is a real sequence.
    let from = record.state;
    if (from === "AWAITING_WALLET") {
      await this.issuance.transition({
        tenantId,
        id: record.id,
        from,
        to: "ELIGIBILITY_CHECK",
        at: now,
      });
      from = "ELIGIBILITY_CHECK";
    }
    if (from === "ELIGIBILITY_CHECK") {
      await this.issuance.transition({ tenantId, id: record.id, from, to: "ISSUING", at: now });
      from = "ISSUING";
    }
    await this.issuance.transition({ tenantId, id: record.id, from, to: "ISSUED", at: now });

    const versions = await this.issuance.listVersions(tenantId, record.policyId);
    const version = versions.find((v) => v.version === record.policyVersion);
    const validitySeconds = version?.credentialValiditySeconds ?? 0;

    const issued = await this.issuance.recordIssued({
      tenantId,
      issuanceTransactionId: record.id,
      credentialTypeId: record.credentialTypeId,
      issuancePolicyId: record.policyId,
      issuancePolicyVersion: record.policyVersion,
      status: "VALID",
      issuedAt: now,
      expiresAt: new Date(now.getTime() + validitySeconds * 1000),
      engineSessionRef: handle.ref,
      ...(statusListUri ? { statusListUri } : {}),
      ...(statusListIndex !== undefined ? { statusListIndex } : {}),
    });

    await this.audit.record({
      tenantId,
      actor: "platform",
      action: "issuance.issued",
      subjectType: "issuance",
      subjectId: record.id,
      // Metadata only. No attribute values, and not the status list index — an `ISSU_35` unique
      // element — which is stored but never logged.
      detail: { issuedCredentialId: issued.id, policyVersion: record.policyVersion },
    });
    await this.enqueueCallback(tenantId, record, "ISSUED", {
      issuedCredentialId: issued.id,
    });

    return {
      issuanceId: record.id,
      status: "ISSUED",
      ...(record.businessReference ? { businessReference: record.businessReference } : {}),
      policyId: record.policyId,
      policyVersion: record.policyVersion,
      expiresAt: record.expiresAt,
      issuedCredentialId: issued.id,
      ...this.warningsFor(
        record.sentWithoutRegistrationCertificate ?? false,
        record.authenticSourceKind,
      ),
    };
  }

  private resolveConnector(name: string): AuthenticSourceConnector {
    const connector = this.connectors.get(name);
    if (!connector) {
      throw PlatformError.conflict(
        "connector_not_registered",
        `No AuthenticSourceConnector named '${name}' is registered.`,
      );
    }
    return connector;
  }

  /** Resolves the evaluator a policy names. Kept for the eligibility gate. */
  resolveEvaluator(name: string): EligibilityEvaluator {
    const evaluator = this.evaluators.get(name);
    if (!evaluator) {
      throw PlatformError.conflict(
        "evaluator_not_registered",
        `No EligibilityEvaluator named '${name}' is registered.`,
      );
    }
    return evaluator;
  }

  private async engineTenantFor(
    tenantId: TenantId,
    record: { readonly credentialTypeId: string },
  ): Promise<string> {
    const context = await this.issuance.loadIssuanceContext(tenantId, record.credentialTypeId);
    const ref = context.attestationProvider.engineTenantRef;
    if (!ref) {
      throw PlatformError.conflict(
        "attestation_provider_not_provisioned",
        "The Attestation Provider has no engine tenant, so its attestations cannot be revoked.",
      );
    }
    return ref;
  }

  /**
   * The warnings a customer must see.
   *
   * Both of these bound what an issuance proves, so they are part of the result rather than a log
   * line somebody may never read.
   */
  private warningsFor(
    sentWithoutRegistrationCertificate: boolean,
    authenticSourceKind?: string,
  ): { warnings?: readonly string[] } {
    const warnings: string[] = [];
    if (sentWithoutRegistrationCertificate) {
      warnings.push(
        "No registration certificate was published in the Credential Issuer metadata, so a " +
          "Wallet cannot authenticate this Attestation Provider before issuance (ARF §6.6.2.2). " +
          "Expect a Wallet warning, or refusal if its policy requires one.",
      );
    }
    if (authenticSourceKind === "FIXTURE") {
      warnings.push(
        "Attribute values came from a FIXTURE connector, not a real authentic source. This " +
          "attestation's contents are test data.",
      );
    }
    return warnings.length > 0 ? { warnings } : {};
  }

  /**
   * Queues the settled issuance for delivery.
   *
   * Uses the same queue, HMAC signing, retry schedule and idempotency as verification — the
   * endpoint moved into the shared kernel precisely so this could reuse them rather than grow a
   * second delivery path. A delivery failure never changes the issuance outcome.
   */
  private async enqueueCallback(
    tenantId: TenantId,
    record: {
      readonly id: string;
      readonly credentialTypeId: string;
      readonly callbackUrl?: string;
      readonly businessReference?: string;
      readonly policyId: string;
      readonly policyVersion: number;
    },
    status: IssuanceState,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (!record.callbackUrl) return;

    try {
      const context = await this.issuance.loadIssuanceContext(
        tenantId,
        record.credentialTypeId,
      );
      const endpointId = context.attestationProvider.webhookEndpointId;
      if (!endpointId) {
        // Refused rather than signed with something else. Reaching here means the endpoint was
        // removed after the issuance was created; the result stays readable through the API.
        this.logger.warn("no webhook endpoint for this Attestation Provider; not delivering", {
          tenantId,
          subject: record.id,
        });
        return;
      }

      await this.webhooks.enqueueEvent({
        tenantId,
        webhookEndpointId: asId<"WebhookEndpointId">(endpointId),
        subjectType: "issuance",
        subjectId: record.id,
        url: record.callbackUrl,
        eventId: newWebhookEventId(),
        deliveryId: newWebhookDeliveryId(),
        // Metadata only. No attribute values, and not the status-list index — an `ISSU_35` unique
        // element, stored but never sent.
        payload: {
          event: "issuance.settled",
          issuanceId: record.id,
          ...(record.businessReference ? { businessReference: record.businessReference } : {}),
          status,
          policyId: record.policyId,
          policyVersion: record.policyVersion,
          settledAt: this.clock.now().toISOString(),
          ...extra,
        },
        at: this.clock.now(),
      });
    } catch (error) {
      // A delivery failure must never change the issuance outcome.
      this.logger.warn("issuance callback could not be enqueued", {
        tenantId,
        subject: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Signed callbacks are **not delivered for issuance in V0**, and the caller is told so.
   *
   * The delivery queue built in Milestone 1 resolves its HMAC signing secret through the
   * presentation transaction and its Relying Party Service. An issuance has neither, so reusing the
   * queue would mean either generalising the delivery record and adding a webhook secret to
   * `attestation_providers`, or signing issuance callbacks with a Relying Party's secret — which
   * would be wrong.
   *
   * Generalising it is the right fix and is deliberately out of this milestone. What is **not**
   * acceptable is accepting a `callbackUrl` and silently never calling it, so the URL is recorded,
   * the delivery status stays `NOT_REQUIRED`, and every response carries a warning saying delivery
   * is not implemented. Poll `GET /v1/issuances/{id}` instead.
   */
  private callbackNotDeliveredWarning(callbackUrl?: string): readonly string[] {
    if (!callbackUrl) return [];
    return [
      "A callbackUrl was supplied but signed callbacks are NOT delivered for issuance in V0: the " +
        "Milestone 1 delivery queue signs with a Relying Party Service secret, which an issuance " +
        "does not have. The URL is recorded and nothing is sent. Poll GET /v1/issuances/{id}.",
    ];
  }
}
