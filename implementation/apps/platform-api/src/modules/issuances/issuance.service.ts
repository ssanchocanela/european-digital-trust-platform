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
  sentWithoutRegistrationCertificate,
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
import { assertPayloadSatisfiesSchema } from "./payload-schema.js";
import type { WalletInitiatedClaims } from "./wallet-initiated-claims.js";

export interface CreateIssuanceCommand {
  readonly tenantId: TenantId;
  readonly policyId: string;
  readonly subjectReference: string;
  /**
   * Attribute values from the caller. Accepted only by a connector that declares
   * `acceptsSuppliedAttributes`, and only in `TEST` — see `assertSuppliedAttributesAllowed`.
   * Content: passed down to the source and out of scope when `create` returns.
   */
  readonly suppliedAttributes?: Readonly<Record<string, unknown>>;
  readonly businessReference?: string;
  readonly callbackUrl?: string;
  /**
   * Set for a **wallet-initiated** issuance: the opaque reference of the authorization request the
   * wallet pushed before being sent to the hosted form. No offer is created; the validated claims
   * are held for the protocol engine, which asks for them when the wallet requests the credential
   * (`claimsForEngineSession`).
   */
  readonly walletAuthorizationRequest?: string;
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
  /**
   * Only on a wallet-initiated issuance: which engine tenant will ask for the held claims. The
   * hosted form needs it to send the browser back to the right authorization endpoint.
   */
  readonly walletInitiated?: { readonly engineTenantRef: string };
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
    /** Present only when wallet-initiated issuance is configured. */
    private readonly walletInitiated?: WalletInitiatedClaims,
  ) {}

  /**
   * Creates an issuance transaction and an offer the Wallet can collect.
   *
   * Attribute values are **not** fetched here — see the class note.
   */
  async create(command: CreateIssuanceCommand): Promise<IssuanceView> {
    const now = this.clock.now();

    const { policy, version, context, plan, engineTenantRef } = await this.compileForPolicy(
      command.tenantId,
      command.policyId,
      now,
    );

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
    // Before the transaction exists, so a refused request leaves nothing behind.
    assertSuppliedAttributesAllowed(
      connector,
      command.suppliedAttributes,
      context.attestationProvider.trustEnvironment,
    );
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
    const sourceAttributes = await this.fetchFromSource(
      connector,
      plan,
      command.tenantId,
      command.subjectReference,
      version,
      command.suppliedAttributes,
    );

    // The eligibility gate, for every flow.
    //
    // Answered here because here is where the answer exists: the business client named the subject
    // — `subjectReference` is required in every flow — and the attributes above were fetched from
    // the authentic source to build the offer. Answering now asks that source **once** rather than
    // twice, and refuses the business client synchronously instead of refusing a person who has
    // already scanned a code.
    //
    // PID-during-issuance does not change that. Its `oid4vp` authorization server makes the engine
    // require a PID presentation before it will issue, which authorises the **holder**; it supplies
    // no eligibility attributes and does not tell us who the subject is, since we were told. An
    // earlier version of this code skipped the evaluation for that flow on the assumption that it
    // would run at the later gate instead, and the later gate evaluates nothing — so that flow had
    // no eligibility check at all. Whether the presented PID *matches* the named subject is a
    // separate question, about holder binding rather than about a rule.
    //
    // Until 13 September 2026 no flow evaluated anything: `advanceToIssuing` walked through
    // ELIGIBILITY_CHECK unconditionally, so the transition log asserted a decision nobody had made
    // and NOT_ELIGIBLE was unreachable. `interop-findings.md` A19.
    {
      await this.issuance.transition({
        tenantId: command.tenantId,
        id: issuanceId,
        from: "CREATED",
        to: "ELIGIBILITY_CHECK",
        at: this.clock.now(),
      });

      const evaluator = this.resolveEvaluator(version.eligibilityRule.evaluator);
      const decision = evaluator.evaluate({
        // The source's answer, not the narrowed one: the rule may turn on an attribute the
        // credential deliberately does not carry.
        attributes: sourceAttributes,
        parameters: version.eligibilityRule.parameters,
        at: this.clock.now(),
      });

      if (!decision.eligible) {
        await this.issuance.transition({
          tenantId: command.tenantId,
          id: issuanceId,
          from: "ELIGIBILITY_CHECK",
          to: "NOT_ELIGIBLE",
          at: this.clock.now(),
          // The reason is the evaluator's own words about a rule, never an attribute value: it
          // reaches the customer-facing result, and `OIA_16` keeps disclosed values out of that.
          patch: decision.reason ? { eligibilityReason: decision.reason } : {},
        });
        await this.audit.record({
          tenantId: command.tenantId,
          actor: "platform",
          action: "issuance.not_eligible",
          subjectType: "issuance",
          subjectId: issuanceId,
          detail: {
            policyId: policy.id,
            policyVersion: version.version,
            evaluator: version.eligibilityRule.evaluator,
          },
        });

        // No offer is created. Inviting a Wallet to collect something that will not be issued
        // wastes an engine session and tells the holder nothing useful.
        return {
          issuanceId,
          status: "NOT_ELIGIBLE",
          ...(command.businessReference
            ? { businessReference: command.businessReference }
            : {}),
          policyId: policy.id,
          policyVersion: version.version,
          ...(decision.reason ? { notEligibleReason: decision.reason } : {}),
          expiresAt,
          ...this.warningsFor(false, connector.kind),
        };
      }
    }

    // Narrowed only now, and only for the credential: everything the type does not declare is
    // dropped before the attributes reach the engine.
    const claims = this.narrowForCredential(sourceAttributes, plan, version);

    if (command.walletAuthorizationRequest !== undefined) {
      return await this.holdForWallet({
        command,
        issuanceId,
        engineTenantRef,
        claims,
        expiresAt,
        policyId: policy.id,
        policyVersion: version.version,
        sentWithout: sentWithoutRegistrationCertificate(plan),
        connectorKind: connector.kind,
        rulebook: plan.credential.rulebookIdentifier,
      });
    }

    const offer = await this.issuer.createCredentialOffer({
      plan,
      claims,
      sessionTtlSeconds: lifetime,
    });

    await this.issuance.transition({
      tenantId: command.tenantId,
      id: issuanceId,
      from: "ELIGIBILITY_CHECK",
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

  /**
   * The wallet-initiated ending of `create`: the claims are held, not offered.
   *
   * The transaction stops at `OFFER_READY` — the form is confirmed and the attestation is ready to
   * be collected — with no engine session yet, because the engine's session belongs to the wallet's
   * authorization request and is learnt only when the engine asks for the claims.
   */
  private async holdForWallet(input: {
    readonly command: CreateIssuanceCommand;
    readonly issuanceId: string;
    readonly engineTenantRef: string;
    readonly claims: SourceAttributes;
    readonly expiresAt: Date;
    readonly policyId: string;
    readonly policyVersion: number;
    readonly sentWithout: boolean;
    readonly connectorKind: AuthenticSourceConnector["kind"];
    readonly rulebook: string;
  }): Promise<IssuanceView> {
    const { command, issuanceId, engineTenantRef } = input;
    const requestUri = command.walletAuthorizationRequest as string;
    if (!this.walletInitiated) {
      throw PlatformError.conflict(
        "wallet_initiated_issuance_not_configured",
        "This deployment does not hold claims for wallet-initiated issuance.",
      );
    }
    const held = this.walletInitiated.hold(requestUri, {
      tenantId: command.tenantId,
      issuanceId,
      engineTenantRef,
      claims: input.claims,
      expiresAt: input.expiresAt,
    });
    if (!held) {
      throw PlatformError.conflict(
        "wallet_authorization_request_already_used",
        "This authorization request already has an attestation waiting for it.",
      );
    }

    await this.issuance.transition({
      tenantId: command.tenantId,
      id: issuanceId,
      from: "ELIGIBILITY_CHECK",
      to: "OFFER_READY",
      at: this.clock.now(),
      patch: { engineTenantRef, sentWithoutRegistrationCertificate: input.sentWithout },
    });
    await this.audit.record({
      tenantId: command.tenantId,
      actor: "platform",
      action: "issuance.created",
      subjectType: "issuance",
      subjectId: issuanceId,
      detail: {
        policyId: input.policyId,
        policyVersion: input.policyVersion,
        authenticSourceKind: input.connectorKind,
        sentWithoutRegistrationCertificate: input.sentWithout,
        rulebook: input.rulebook,
        walletInitiated: true,
      },
    });

    return {
      issuanceId,
      status: "OFFER_READY",
      ...(command.businessReference ? { businessReference: command.businessReference } : {}),
      policyId: input.policyId,
      policyVersion: input.policyVersion,
      expiresAt: input.expiresAt,
      walletInitiated: { engineTenantRef },
      ...this.warningsFor(input.sentWithout, input.connectorKind),
    };
  }

  /**
   * The protocol engine asking for a wallet-initiated issuance's claims.
   *
   * The engine names its session; the session names the wallet's authorization request; the request
   * names the held claims. They are handed over **once** and forgotten, and the transaction learns
   * its engine session here, which is what lets `get` follow it to `ISSUED` and lets its status be
   * changed later. Returns `undefined` when nothing is held — the engine then has nothing to issue,
   * which is the correct outcome for an authorization that did not pass through the form.
   */
  async claimsForEngineSession(input: {
    readonly engineTenantRef: string;
    readonly engineSessionRef: string;
  }): Promise<SourceAttributes | undefined> {
    if (!this.walletInitiated) return undefined;
    const requestUri = await this.issuer.resolveAuthorizationRequest({
      ref: input.engineSessionRef as CredentialOfferHandle["ref"],
      engineTenantRef: input.engineTenantRef,
    });
    if (!requestUri) return undefined;
    const held = this.walletInitiated.take(input.engineTenantRef, requestUri);
    if (!held) return undefined;

    const tenantId = asId<"TenantId">(held.tenantId);
    await this.issuance.transition({
      tenantId,
      id: held.issuanceId,
      from: "OFFER_READY",
      to: "AWAITING_WALLET",
      at: this.clock.now(),
      patch: { engineSessionRef: input.engineSessionRef },
    });
    return held.claims;
  }

  /**
   * The published version of a policy, compiled against its credential type and provider — shared by
   * `create` and `provisionPolicy`, so what a wallet discovers and what an issuance uses cannot
   * differ.
   */
  private async compileForPolicy(tenantId: TenantId, policyId: string, now: Date) {
    const policy = await this.issuance.findPolicy(tenantId, policyId);
    if (!policy) throw PlatformError.notFound("Issuance policy");
    // The same guard the verification side has had since Milestone 1. It was missing here because
    // nothing could retire an issuance policy — the state was modelled and unreachable — so the
    // check had never had anything to refuse.
    if (policy.status === "RETIRED") {
      throw PlatformError.conflict(
        "policy_retired",
        "The issuance policy has been retired and cannot be used. Attestations already issued " +
          "under it are unaffected and keep the terms they were issued under.",
      );
    }

    const versions = await this.issuance.listVersions(tenantId, policyId);
    const version = resolvePublishedVersion(versions);

    const context = await this.issuance.loadIssuanceContext(tenantId, version.credentialTypeId);

    const engineTenantRef = context.attestationProvider.engineTenantRef;
    const signingKeyBindingRef = context.attestationProvider.signingKeyBindingRef;
    if (!engineTenantRef || !signingKeyBindingRef) {
      throw PlatformError.conflict(
        "attestation_provider_not_provisioned",
        "The Attestation Provider has no engine tenant or signing key. Provision it before issuing.",
      );
    }

    // The engine's issuer configuration is tenant-scoped, so it is composed from the **provider** —
    // every published policy on it — rather than from the policy being issued. Writing it from one
    // policy is `interop-findings.md` A20: each issuance overwrote the last one's authorization
    // servers, and the Credential Issuer's display name became the last credential type's name.
    const issuerConfiguration = await this.issuance.issuerConfigurationInputs(
      tenantId,
      context.attestationProvider.id,
    );

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
        issuerDisplayName: issuerConfiguration.issuerDisplayName,
        eligibilityPresentations: issuerConfiguration.eligibilityPresentations,
        requiresBuiltInAuthorizationServer:
          issuerConfiguration.requiresBuiltInAuthorizationServer,
        ...(issuerConfiguration.accessKeyBindingRef
          ? { accessKeyBindingRef: issuerConfiguration.accessKeyBindingRef }
          : {}),
      },
      at: now,
    });

    return { policy, version, context, plan, engineTenantRef };
  }

  /**
   * Writes a policy's published version to the protocol engine ahead of any issuance, and withdraws
   * the configurations of its earlier versions.
   *
   * An offer provisions on demand, because the offer names the configuration. A **wallet-initiated**
   * issuance cannot wait: the wallet reads the issuer's metadata to build its list before anyone has
   * asked for anything, so the configuration must already be there — and only the current one,
   * because the wallet merges every PID configuration of an issuer into one entry and requests them
   * all at once.
   */
  async provisionPolicy(
    tenantId: TenantId,
    policyId: string,
  ): Promise<{ readonly policyVersion: number; readonly withdrawn: readonly number[] }> {
    const { policy, version, plan, engineTenantRef } = await this.compileForPolicy(
      tenantId,
      policyId,
      this.clock.now(),
    );
    await this.provisioning.provisionCredentialConfiguration({ engineTenantRef, plan });
    const versions = await this.issuance.listVersions(tenantId, policy.id);
    const superseded = versions.map((v) => v.version).filter((v) => v !== version.version);
    await this.provisioning.withdrawCredentialConfigurations({
      engineTenantRef,
      policyId: policy.id,
      versions: superseded,
    });
    await this.audit.record({
      tenantId,
      actor: "platform",
      action: "issuance_policy.provisioned",
      subjectType: "issuance_policy",
      subjectId: policy.id,
      detail: { policyVersion: version.version, withdrawnVersions: superseded },
    });
    return { policyVersion: version.version, withdrawn: superseded };
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

    // The engine is told second, and whether it agreed is recorded rather than assumed.
    //
    // A failure here used to leave the platform claiming a status the status list did not carry,
    // with nothing anywhere saying so — the register read `REVOKED`, the API returned
    // `engine_unavailable`, and a Relying Party reading the engine's status list still saw a valid
    // attestation. Three parties, three answers, and the operator was shown the reassuring one.
    //
    // The transition stays persisted: rolling it back would mean a revocation the operator
    // requested silently not happening, which is worse, and it would race a concurrent writer. What
    // changes is that the record now distinguishes *intended* from *in effect*.
    try {
      await this.issuer.updateCredentialStatus({
        session: {
          ref: record.engineSessionRef as CredentialOfferHandle["ref"],
          engineTenantRef: version ? await this.engineTenantFor(input.tenantId, record) : "",
        },
        status: input.to,
        // Which configuration the transition applies to. The engine's contract calls this optional
        // and its omitted path returns 500 — A26 — so the platform always names it.
        policyId: record.issuancePolicyId,
        policyVersion: record.issuancePolicyVersion,
      });
    } catch (error) {
      // Audited before rethrowing, because this is the one event nothing else records: the caller
      // gets an error and goes away, and without this the divergence exists only as a row whose
      // `statusConfirmedAt` is null.
      await this.audit.record({
        tenantId: input.tenantId,
        actor: "platform",
        action: "credential.status_change_unconfirmed",
        subjectType: "issued_credential",
        subjectId: record.id,
        detail: {
          from: record.status,
          to: input.to,
          // The code only. An engine message can carry detail that is not ours to store.
          failureCode: error instanceof PlatformError ? error.code : "engine_error",
        },
      });
      throw error;
    }

    await this.issuance.confirmStatus({
      tenantId: input.tenantId,
      id: record.id,
      status: input.to,
      at: now,
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
  /**
   * What the authentic source said, before anything is dropped.
   *
   * Separate from narrowing because the eligibility rule and the credential need different sets.
   * A badge gated on age is the ordinary case: `birthdate` decides whether it may be issued and
   * has no business being *in* it, so narrowing first leaves the evaluator with nothing to read —
   * which is exactly what happened on 13 September 2026, when the adult fixture subject was
   * refused for having "no usable date of birth".
   */
  private async fetchFromSource(
    connector: AuthenticSourceConnector,
    plan: IssuancePlan,
    tenantId: string,
    subjectReference: string,
    version: {
      readonly authenticSource: { readonly parameters: Readonly<Record<string, unknown>> };
    },
    suppliedAttributes?: Readonly<Record<string, unknown>>,
  ): Promise<SourceAttributes> {
    const raw = await connector.fetch({
      tenantId,
      subjectReference,
      requestedClaimPaths: plan.claimPathsToFetch,
      parameters: version.authenticSource.parameters,
      ...(suppliedAttributes ? { suppliedAttributes } : {}),
    });
    if (!raw) throw PlatformError.notFound("Subject at the authentic source");
    return raw;
  }

  private narrowForCredential(
    raw: SourceAttributes,
    plan: IssuancePlan,
    version: {
      readonly authenticSource: { readonly parameters: Readonly<Record<string, unknown>> };
    },
  ): SourceAttributes {
    // Validates and drops anything the type does not declare. The error carries claim paths only.
    const narrowed = narrowToDeclaredClaims(raw, {
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
    // Then the rules between claims, on exactly what the engine will receive. After narrowing, so a
    // schema is never satisfied by an attribute the credential would not carry.
    if (plan.credential.payloadSchema) {
      assertPayloadSatisfiesSchema(
        plan.credential.payloadSchema,
        plan.credential.vct,
        narrowed,
      );
    }
    return narrowed;
  }

  private async advanceToIssuing(tenantId: TenantId, id: string): Promise<void> {
    const at = this.clock.now();
    // Walking through ELIGIBILITY_CHECK here records that the Wallet arrived and issuance began.
    //
    // For every flow the platform currently runs, the decision was already taken at creation and
    // an ineligible subject never reached AWAITING_WALLET — so this is a passage, not a gate, and
    // the comment says so rather than describing a check that does not happen here. The
    // PID-during-issuance flow is where this becomes a real gate, and it is **not yet exercised**
    // end to end (`interop-findings.md` A17): when it is, the evaluator must be consulted at this
    // point, against the attributes the presentation identified.
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

/**
 * The guard on the one exception to "a subject reference, never attribute values".
 *
 * Refuses in both directions: values sent to a source that does not take them would be silently
 * ignored — a caller would believe it had set something it had not — and a source that takes them
 * with none supplied has nothing to issue from. And refuses outside `TEST` structurally, because a
 * caller-asserted attestation is test data by construction and `PRODUCTION` must never issue one.
 */
export const assertSuppliedAttributesAllowed = (
  connector: Pick<AuthenticSourceConnector, "name" | "kind" | "acceptsSuppliedAttributes">,
  suppliedAttributes: Readonly<Record<string, unknown>> | undefined,
  trustEnvironment: "TEST" | "PRODUCTION",
): void => {
  const accepts = connector.acceptsSuppliedAttributes === true;
  if (!accepts) {
    if (suppliedAttributes !== undefined) {
      throw PlatformError.validation(
        "subject_attributes_not_accepted",
        `The authentic source '${connector.name}' takes a subject reference, not attribute values. ` +
          "Only the operator-form test source accepts subjectAttributes.",
      );
    }
    return;
  }
  if (connector.kind !== "FIXTURE" || trustEnvironment !== "TEST") {
    throw PlatformError.conflict(
      "supplied_attributes_test_only",
      "Attribute values supplied by the caller are test data by construction, and are accepted " +
        "only from a FIXTURE source under a TEST Attestation Provider.",
    );
  }
  if (suppliedAttributes === undefined || Object.keys(suppliedAttributes).length === 0) {
    throw PlatformError.validation(
      "subject_attributes_required",
      `The authentic source '${connector.name}' issues from the values in subjectAttributes, and ` +
        "none were supplied.",
    );
  }
};
