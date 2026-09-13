import { randomUUID } from "node:crypto";
import {
  assertIssuanceTransition,
  assertStatusTransition,
  type CredentialStatus,
  type CredentialType,
  type IssuancePolicy,
  type IssuancePolicyVersion,
  type IssuanceState,
  type IssuedCredentialRecord,
  isIssuanceTerminal,
  nextVersionNumber,
} from "@edtp/domain";
import type { TenantId } from "@edtp/shared";
import { PlatformError } from "@edtp/shared";
import { and, desc, eq, lte } from "drizzle-orm";
import type { Database } from "../db.js";
import {
  attestationProviders,
  credentialTypes,
  issuancePolicies,
  issuancePolicyVersions,
  issuanceTransactions,
  issuanceTransactionTransitions,
  issuedCredentials,
  organisations,
} from "../schema.js";

/** What an issuance needs, loaded in one place so the service never assembles it piecemeal. */
export interface IssuanceContext {
  readonly credentialType: CredentialType;
  readonly attestationProvider: {
    readonly id: string;
    readonly tenantId: string;
    readonly organisationId: string;
    readonly registrarAssignedIdentifier: string;
    readonly trustEnvironment: "TEST" | "PRODUCTION";
    readonly createdAt: Date;
    readonly signingKeyBindingRef?: string;
    readonly registrationCertificateJwt?: string;
    readonly registrationCertificateNotAfter?: Date;
    readonly engineTenantRef?: string;
    /** The shared callback destination. Same kernel type the verification side references. */
    readonly webhookEndpointId?: string;
  };
}

export interface IssuanceTransactionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly credentialTypeId: string;
  readonly state: IssuanceState;
  readonly businessReference?: string;
  readonly subjectReference: string;
  readonly authenticSourceKind?: string;
  readonly eligibilityReason?: string;
  readonly engineSessionRef?: string;
  readonly engineTenantRef?: string;
  readonly sentWithoutRegistrationCertificate?: boolean;
  readonly callbackUrl?: string;
  readonly deliveryStatus: string;
  readonly failureCode?: string;
  readonly failureMessage?: string;
  readonly providerSideFailure?: boolean;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const asTrustEnvironment = (value: string): "TEST" | "PRODUCTION" =>
  value === "PRODUCTION" ? "PRODUCTION" : "TEST";

export class IssuanceRepository {
  constructor(private readonly db: Database) {}

  // --- configuration -------------------------------------------------------

  async createAttestationProvider(input: {
    readonly tenantId: TenantId;
    readonly organisationId: string;
    readonly registrarAssignedIdentifier: string;
    readonly registrar?: string;
    readonly trustEnvironment: "TEST" | "PRODUCTION";
    readonly at: Date;
  }): Promise<{ readonly id: string }> {
    const id = randomUUID();
    await this.db.insert(attestationProviders).values({
      id,
      tenantId: input.tenantId,
      organisationId: input.organisationId,
      registrarAssignedIdentifier: input.registrarAssignedIdentifier,
      registrar: input.registrar ?? null,
      trustEnvironment: input.trustEnvironment,
      createdAt: input.at,
    });
    return { id };
  }

  /** Records the engine tenant, signing key and registration certificate for a provider. */
  async provisionAttestationProvider(input: {
    readonly tenantId: TenantId;
    readonly attestationProviderId: string;
    readonly engineTenantRef: string;
    readonly signingKeyBindingRef: string;
    readonly registrationCertificateJwt?: string;
    readonly registrationCertificateNotAfter?: Date;
    readonly webhookEndpointId?: string;
  }): Promise<void> {
    // An engine tenant serves exactly one Attestation Provider. The unique index added in migration
    // 0006 is the real guarantee; this check exists because the constraint's own message names only
    // the index, and the operator needs to be told *which* provider already holds the reference.
    const [taken] = await this.db
      .select({ id: attestationProviders.id })
      .from(attestationProviders)
      .where(eq(attestationProviders.engineTenantRef, input.engineTenantRef))
      .limit(1);
    if (taken && taken.id !== input.attestationProviderId) {
      throw PlatformError.conflict(
        "engine_tenant_already_assigned",
        "That engine tenant already serves another Attestation Provider. The engine's issuer " +
          "configuration is tenant-scoped, so sharing one would make each provider overwrite the " +
          "other's authorization servers, display name and registration certificate.",
      );
    }

    const updated = await this.db
      .update(attestationProviders)
      .set({
        engineTenantRef: input.engineTenantRef,
        signingKeyBindingRef: input.signingKeyBindingRef,
        registrationCertificateJwt: input.registrationCertificateJwt ?? null,
        registrationCertificateNotAfter: input.registrationCertificateNotAfter ?? null,
        ...(input.webhookEndpointId ? { webhookEndpointId: input.webhookEndpointId } : {}),
      })
      .where(
        and(
          eq(attestationProviders.id, input.attestationProviderId),
          eq(attestationProviders.tenantId, input.tenantId),
        ),
      )
      .returning({ id: attestationProviders.id });
    if (updated.length === 0) throw PlatformError.notFound("Attestation Provider");
  }

  async createCredentialType(input: {
    readonly tenantId: TenantId;
    readonly type: Omit<CredentialType, "id" | "tenantId" | "createdAt">;
    readonly at: Date;
  }): Promise<{ readonly id: string }> {
    const id = randomUUID();
    const t = input.type;
    await this.db.insert(credentialTypes).values({
      id,
      tenantId: input.tenantId,
      attestationProviderId: t.attestationProviderId,
      name: t.name,
      format: t.format,
      vct: t.vct ?? null,
      doctype: t.doctype ?? null,
      rulebookIdentifier: t.rulebook.identifier,
      rulebookVersion: t.rulebook.version,
      rulebookPublicationUri: t.rulebook.publicationUri ?? null,
      rulebookAnchorSource: t.rulebook.anchorSource,
      claims: t.claims,
      display: t.display,
      validitySeconds: t.validitySeconds,
      statusMechanism: t.statusMechanism,
      requiresKeyBinding: t.requiresKeyBinding,
      createdAt: input.at,
    });
    return { id };
  }

  async findCredentialType(
    tenantId: TenantId,
    id: string,
  ): Promise<CredentialType | undefined> {
    const [row] = await this.db
      .select()
      .from(credentialTypes)
      .where(and(eq(credentialTypes.id, id), eq(credentialTypes.tenantId, tenantId)))
      .limit(1);
    return row ? this.toCredentialType(row) : undefined;
  }

  /** Loads everything an issuance needs, with tenant scoping applied at every join. */
  async loadIssuanceContext(
    tenantId: TenantId,
    credentialTypeId: string,
  ): Promise<IssuanceContext> {
    const type = await this.findCredentialType(tenantId, credentialTypeId);
    if (!type) throw PlatformError.notFound("Credential type");

    const [provider] = await this.db
      .select()
      .from(attestationProviders)
      .where(
        and(
          eq(attestationProviders.id, type.attestationProviderId),
          eq(attestationProviders.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!provider) throw PlatformError.notFound("Attestation Provider");

    return {
      credentialType: type,
      attestationProvider: {
        id: provider.id,
        tenantId: provider.tenantId,
        organisationId: provider.organisationId,
        registrarAssignedIdentifier: provider.registrarAssignedIdentifier,
        trustEnvironment: asTrustEnvironment(provider.trustEnvironment),
        createdAt: provider.createdAt,
        ...(provider.signingKeyBindingRef
          ? { signingKeyBindingRef: provider.signingKeyBindingRef }
          : {}),
        ...(provider.registrationCertificateJwt
          ? { registrationCertificateJwt: provider.registrationCertificateJwt }
          : {}),
        ...(provider.registrationCertificateNotAfter
          ? { registrationCertificateNotAfter: provider.registrationCertificateNotAfter }
          : {}),
        ...(provider.engineTenantRef ? { engineTenantRef: provider.engineTenantRef } : {}),
        ...(provider.webhookEndpointId
          ? { webhookEndpointId: provider.webhookEndpointId }
          : {}),
      },
    };
  }

  /**
   * Releases a provider's engine tenant, so another provider can be given it.
   *
   * The counterpart to the one-provider-per-engine-tenant rule added in migration 0006. Without it
   * that rule is a one-way door: the first provider to claim an engine tenant holds it for the life
   * of the database, and a provider registered by mistake makes its engine tenant permanently
   * unusable. A constraint with no way back is a defect, not a safeguard.
   *
   * The signing key reference goes with it. Both describe the same engine tenant, and leaving a key
   * reference behind would let a later read believe the provider is still provisioned. Afterwards
   * issuance from it fails with `attestation_provider_not_provisioned`, which is accurate.
   *
   * The engine-side objects are **not** deleted: the engine tenant, its keys and its configuration
   * stay as they are. This records that the platform no longer claims the tenant for this provider —
   * whoever takes it next provisions it and overwrites what it finds.
   */
  async releaseEngineTenant(input: {
    readonly tenantId: TenantId;
    readonly attestationProviderId: string;
  }): Promise<{ readonly released: string | undefined }> {
    const [row] = await this.db
      .select({ ref: attestationProviders.engineTenantRef })
      .from(attestationProviders)
      .where(
        and(
          eq(attestationProviders.id, input.attestationProviderId),
          eq(attestationProviders.tenantId, input.tenantId),
        ),
      )
      .limit(1);
    if (!row) throw PlatformError.notFound("Attestation Provider");

    await this.db
      .update(attestationProviders)
      .set({ engineTenantRef: null, signingKeyBindingRef: null })
      .where(
        and(
          eq(attestationProviders.id, input.attestationProviderId),
          eq(attestationProviders.tenantId, input.tenantId),
        ),
      );
    return { released: row.ref ?? undefined };
  }

  /**
   * Everything the engine tenant's **issuer-level** configuration depends on, for one provider.
   *
   * `POST /issuer/config` is tenant-scoped: `authorizationServers`, `display` and
   * `registrationCertificate` all belong to the engine tenant, not to a credential configuration.
   * The platform used to write it from whichever credential type happened to be provisioning, so
   * each issuance silently overwrote the last one's — `interop-findings.md` A20. Composing it needs
   * the whole provider, which is what this reads.
   *
   * Only **published** versions count. A draft has not been validated for use and must not change
   * what the Credential Issuer metadata advertises to every Wallet.
   */
  async issuerConfigurationInputs(
    tenantId: TenantId,
    attestationProviderId: string,
  ): Promise<{
    /** The Credential Issuer's own display name — the organisation's legal name. */
    readonly issuerDisplayName: string;
    /** Distinct presentation policies used as an eligibility gate, across the provider. */
    readonly eligibilityPresentationPolicyIds: readonly string[];
    /** True when at least one published policy issues without a presentation gate. */
    readonly requiresBuiltInAuthorizationServer: boolean;
  }> {
    const [org] = await this.db
      .select({ legalName: organisations.legalName })
      .from(attestationProviders)
      .innerJoin(organisations, eq(attestationProviders.organisationId, organisations.id))
      .where(
        and(
          eq(attestationProviders.id, attestationProviderId),
          eq(attestationProviders.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!org) throw PlatformError.notFound("Attestation Provider");

    const rows = await this.db
      .select({ eligibility: issuancePolicyVersions.eligibilityPresentationPolicyId })
      .from(issuancePolicyVersions)
      .innerJoin(
        credentialTypes,
        eq(issuancePolicyVersions.credentialTypeId, credentialTypes.id),
      )
      .where(
        and(
          eq(issuancePolicyVersions.tenantId, tenantId),
          eq(credentialTypes.attestationProviderId, attestationProviderId),
          eq(issuancePolicyVersions.status, "PUBLISHED"),
        ),
      );

    const gated = new Set<string>();
    let ungated = false;
    for (const row of rows) {
      if (row.eligibility) gated.add(row.eligibility);
      else ungated = true;
    }

    return {
      issuerDisplayName: org.legalName,
      eligibilityPresentationPolicyIds: [...gated],
      // A provider with no published policy at all still needs one server, because the engine
      // requires a non-empty list and the transaction being provisioned is about to need it.
      requiresBuiltInAuthorizationServer: ungated || gated.size === 0,
    };
  }

  /** The provider's engine tenant, for the provider-authentication check (trust gate a). */
  async loadIssuanceContextByProvider(
    tenantId: TenantId,
    attestationProviderId: string,
  ): Promise<{ readonly engineTenantRef?: string }> {
    const [row] = await this.db
      .select()
      .from(attestationProviders)
      .where(
        and(
          eq(attestationProviders.id, attestationProviderId),
          eq(attestationProviders.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!row) throw PlatformError.notFound("Attestation Provider");
    return row.engineTenantRef ? { engineTenantRef: row.engineTenantRef } : {};
  }

  // --- policies ------------------------------------------------------------

  async createPolicy(input: {
    readonly tenantId: TenantId;
    readonly credentialTypeId: string;
    readonly name: string;
    readonly at: Date;
  }): Promise<IssuancePolicy> {
    const id = randomUUID();
    await this.db.insert(issuancePolicies).values({
      id,
      tenantId: input.tenantId,
      credentialTypeId: input.credentialTypeId,
      name: input.name,
      status: "ACTIVE",
      createdAt: input.at,
    });
    return {
      id,
      tenantId: input.tenantId,
      credentialTypeId: input.credentialTypeId,
      name: input.name,
      status: "ACTIVE",
      createdAt: input.at,
    };
  }

  async findPolicy(tenantId: TenantId, id: string): Promise<IssuancePolicy | undefined> {
    const [row] = await this.db
      .select()
      .from(issuancePolicies)
      .where(and(eq(issuancePolicies.id, id), eq(issuancePolicies.tenantId, tenantId)))
      .limit(1);
    if (!row) return undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      credentialTypeId: row.credentialTypeId,
      name: row.name,
      status: row.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE",
      createdAt: row.createdAt,
    };
  }

  async listVersions(tenantId: TenantId, policyId: string): Promise<IssuancePolicyVersion[]> {
    const rows = await this.db
      .select()
      .from(issuancePolicyVersions)
      .where(
        and(
          eq(issuancePolicyVersions.policyId, policyId),
          eq(issuancePolicyVersions.tenantId, tenantId),
        ),
      )
      .orderBy(desc(issuancePolicyVersions.version));
    return rows.map((r) => this.toVersion(r));
  }

  async createVersion(input: {
    readonly tenantId: TenantId;
    readonly policyId: string;
    readonly body: Omit<IssuancePolicyVersion, "policyId" | "version" | "status" | "createdAt">;
    readonly publish: boolean;
    readonly at: Date;
  }): Promise<IssuancePolicyVersion> {
    const existing = await this.listVersions(input.tenantId, input.policyId);
    const version = nextVersionNumber(existing);
    const status = input.publish ? "PUBLISHED" : "DRAFT";

    await this.db.insert(issuancePolicyVersions).values({
      id: randomUUID(),
      tenantId: input.tenantId,
      policyId: input.policyId,
      version,
      status,
      credentialTypeId: input.body.credentialTypeId,
      purpose: input.body.purpose,
      eligibilityRule: input.body.eligibilityRule,
      authenticSource: input.body.authenticSource,
      holderBinding: input.body.holderBinding,
      flow: input.body.flow,
      credentialValiditySeconds: input.body.credentialValiditySeconds,
      statusPolicy: input.body.statusPolicy,
      retentionPolicy: input.body.retentionPolicy,
      eligibilityPresentationPolicyId: input.body.eligibilityPresentationPolicyId ?? null,
      createdAt: input.at,
      publishedAt: input.publish ? input.at : null,
    });

    return {
      ...input.body,
      policyId: input.policyId,
      version,
      status,
      createdAt: input.at,
      ...(input.publish ? { publishedAt: input.at } : {}),
    };
  }

  // --- transactions --------------------------------------------------------

  async createTransaction(record: IssuanceTransactionRecord): Promise<void> {
    await this.db.insert(issuanceTransactions).values({
      id: record.id,
      tenantId: record.tenantId,
      policyId: record.policyId,
      policyVersion: record.policyVersion,
      credentialTypeId: record.credentialTypeId,
      state: record.state,
      businessReference: record.businessReference ?? null,
      subjectReference: record.subjectReference,
      authenticSourceKind: record.authenticSourceKind ?? null,
      eligibilityReason: null,
      engineSessionRef: record.engineSessionRef ?? null,
      engineTenantRef: record.engineTenantRef ?? null,
      sentWithoutRegistrationCertificate: record.sentWithoutRegistrationCertificate ?? null,
      callbackUrl: record.callbackUrl ?? null,
      deliveryStatus: record.deliveryStatus,
      failureCode: null,
      failureMessage: null,
      providerSideFailure: null,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    await this.appendTransition(record, record.state, record.state, record.createdAt);
  }

  async findTransaction(
    tenantId: TenantId,
    id: string,
  ): Promise<IssuanceTransactionRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(issuanceTransactions)
      .where(and(eq(issuanceTransactions.id, id), eq(issuanceTransactions.tenantId, tenantId)))
      .limit(1);
    return row ? this.toTransaction(row) : undefined;
  }

  /**
   * Moves a transaction to a new state.
   *
   * Validated against the domain table **and** applied with the expected prior state in the
   * `WHERE` clause, so two concurrent pollers cannot both settle the same transaction — the
   * loser affects zero rows and is told so rather than silently winning.
   */
  async transition(input: {
    readonly tenantId: TenantId;
    readonly id: string;
    readonly from: IssuanceState;
    readonly to: IssuanceState;
    readonly at: Date;
    readonly patch?: {
      readonly engineSessionRef?: string;
      readonly engineTenantRef?: string;
      readonly sentWithoutRegistrationCertificate?: boolean;
      readonly authenticSourceKind?: string;
      readonly eligibilityReason?: string;
      readonly failureCode?: string;
      readonly failureMessage?: string;
      readonly providerSideFailure?: boolean;
      readonly deliveryStatus?: string;
    };
  }): Promise<void> {
    assertIssuanceTransition(input.from, input.to);

    const updated = await this.db
      .update(issuanceTransactions)
      .set({
        state: input.to,
        updatedAt: input.at,
        ...(input.patch?.engineSessionRef !== undefined
          ? { engineSessionRef: input.patch.engineSessionRef }
          : {}),
        ...(input.patch?.engineTenantRef !== undefined
          ? { engineTenantRef: input.patch.engineTenantRef }
          : {}),
        ...(input.patch?.sentWithoutRegistrationCertificate !== undefined
          ? {
              sentWithoutRegistrationCertificate:
                input.patch.sentWithoutRegistrationCertificate,
            }
          : {}),
        ...(input.patch?.authenticSourceKind !== undefined
          ? { authenticSourceKind: input.patch.authenticSourceKind }
          : {}),
        ...(input.patch?.eligibilityReason !== undefined
          ? { eligibilityReason: input.patch.eligibilityReason }
          : {}),
        ...(input.patch?.failureCode !== undefined
          ? { failureCode: input.patch.failureCode }
          : {}),
        ...(input.patch?.failureMessage !== undefined
          ? { failureMessage: input.patch.failureMessage }
          : {}),
        ...(input.patch?.providerSideFailure !== undefined
          ? { providerSideFailure: input.patch.providerSideFailure }
          : {}),
        ...(input.patch?.deliveryStatus !== undefined
          ? { deliveryStatus: input.patch.deliveryStatus }
          : {}),
      })
      .where(
        and(
          eq(issuanceTransactions.id, input.id),
          eq(issuanceTransactions.tenantId, input.tenantId),
          // The concurrency guard.
          eq(issuanceTransactions.state, input.from),
        ),
      )
      .returning({ id: issuanceTransactions.id });

    if (updated.length === 0) {
      throw PlatformError.conflict(
        "issuance_transition_conflict",
        `The issuance transaction was not in state ${input.from}; another writer changed it first.`,
      );
    }

    await this.db.insert(issuanceTransactionTransitions).values({
      id: randomUUID(),
      tenantId: input.tenantId,
      issuanceTransactionId: input.id,
      fromState: input.from,
      toState: input.to,
      at: input.at,
    });
  }

  /** Transactions past their lifetime that have not settled. Used by the expiry job. */
  async findExpired(at: Date, limit = 50): Promise<IssuanceTransactionRecord[]> {
    const rows = await this.db
      .select()
      .from(issuanceTransactions)
      .where(lte(issuanceTransactions.expiresAt, at))
      .limit(limit);
    return rows.map((r) => this.toTransaction(r)).filter((t) => !isIssuanceTerminal(t.state));
  }

  // --- issued credentials --------------------------------------------------

  async recordIssued(record: Omit<IssuedCredentialRecord, "id">): Promise<{ id: string }> {
    const id = randomUUID();
    await this.db.insert(issuedCredentials).values({
      id,
      tenantId: record.tenantId,
      issuanceTransactionId: record.issuanceTransactionId,
      credentialTypeId: record.credentialTypeId,
      issuancePolicyId: record.issuancePolicyId,
      issuancePolicyVersion: record.issuancePolicyVersion,
      status: record.status,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      engineSessionRef: record.engineSessionRef,
      statusListUri: record.statusListUri ?? null,
      statusListIndex: record.statusListIndex ?? null,
      statusChangedAt: record.statusChangedAt ?? null,
    });
    return { id };
  }

  async findIssued(
    tenantId: TenantId,
    id: string,
  ): Promise<IssuedCredentialRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(issuedCredentials)
      .where(and(eq(issuedCredentials.id, id), eq(issuedCredentials.tenantId, tenantId)))
      .limit(1);
    if (!row) return undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      issuanceTransactionId: row.issuanceTransactionId,
      credentialTypeId: row.credentialTypeId,
      issuancePolicyId: row.issuancePolicyId,
      issuancePolicyVersion: row.issuancePolicyVersion,
      status: row.status as CredentialStatus,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      engineSessionRef: row.engineSessionRef,
      ...(row.statusListUri ? { statusListUri: row.statusListUri } : {}),
      ...(row.statusListIndex !== null ? { statusListIndex: row.statusListIndex } : {}),
      ...(row.statusChangedAt ? { statusChangedAt: row.statusChangedAt } : {}),
    };
  }

  /**
   * Changes an attestation's status.
   *
   * The domain decides whether the transition is legal — in particular that `REVOKED` is terminal
   * (`AS-AP-07-007` / `VCR_04`), which the engine does **not** enforce. The `WHERE` clause then
   * pins the expected prior status, so a concurrent revoke and reinstate cannot interleave into an
   * un-revocation that the domain check passed a moment earlier.
   */
  async changeStatus(input: {
    readonly tenantId: TenantId;
    readonly id: string;
    readonly from: CredentialStatus;
    readonly to: CredentialStatus;
    readonly suspensionAllowed: boolean;
    readonly at: Date;
  }): Promise<void> {
    assertStatusTransition(input.from, input.to, {
      suspensionAllowed: input.suspensionAllowed,
    });

    const updated = await this.db
      .update(issuedCredentials)
      .set({ status: input.to, statusChangedAt: input.at })
      .where(
        and(
          eq(issuedCredentials.id, input.id),
          eq(issuedCredentials.tenantId, input.tenantId),
          eq(issuedCredentials.status, input.from),
        ),
      )
      .returning({ id: issuedCredentials.id });

    if (updated.length === 0) {
      throw PlatformError.conflict(
        "credential_status_conflict",
        `The attestation was not ${input.from}; another writer changed it first.`,
      );
    }
  }

  // --- mapping -------------------------------------------------------------

  private async appendTransition(
    record: IssuanceTransactionRecord,
    from: IssuanceState,
    to: IssuanceState,
    at: Date,
  ): Promise<void> {
    await this.db.insert(issuanceTransactionTransitions).values({
      id: randomUUID(),
      tenantId: record.tenantId,
      issuanceTransactionId: record.id,
      fromState: from,
      toState: to,
      at,
    });
  }

  private toCredentialType(row: typeof credentialTypes.$inferSelect): CredentialType {
    return {
      id: row.id,
      tenantId: row.tenantId,
      attestationProviderId: row.attestationProviderId,
      name: row.name,
      format: row.format as CredentialType["format"],
      ...(row.vct ? { vct: row.vct } : {}),
      ...(row.doctype ? { doctype: row.doctype } : {}),
      rulebook: {
        identifier: row.rulebookIdentifier,
        version: row.rulebookVersion,
        ...(row.rulebookPublicationUri ? { publicationUri: row.rulebookPublicationUri } : {}),
        anchorSource:
          row.rulebookAnchorSource === "RULEBOOK_AND_PUBLISHED_LIST"
            ? "RULEBOOK_AND_PUBLISHED_LIST"
            : "RULEBOOK_ONLY",
      },
      claims: row.claims as CredentialType["claims"],
      display: row.display as CredentialType["display"],
      validitySeconds: row.validitySeconds,
      statusMechanism:
        row.statusMechanism === "TOKEN_STATUS_LIST" ? "TOKEN_STATUS_LIST" : "NONE",
      requiresKeyBinding: row.requiresKeyBinding,
      createdAt: row.createdAt,
    };
  }

  private toVersion(row: typeof issuancePolicyVersions.$inferSelect): IssuancePolicyVersion {
    return {
      policyId: row.policyId,
      version: row.version,
      status: row.status as IssuancePolicyVersion["status"],
      credentialTypeId: row.credentialTypeId,
      purpose: row.purpose as IssuancePolicyVersion["purpose"],
      eligibilityRule: row.eligibilityRule as IssuancePolicyVersion["eligibilityRule"],
      authenticSource: row.authenticSource as IssuancePolicyVersion["authenticSource"],
      holderBinding: row.holderBinding as IssuancePolicyVersion["holderBinding"],
      flow: row.flow as IssuancePolicyVersion["flow"],
      credentialValiditySeconds: row.credentialValiditySeconds,
      statusPolicy: row.statusPolicy as IssuancePolicyVersion["statusPolicy"],
      retentionPolicy: row.retentionPolicy as IssuancePolicyVersion["retentionPolicy"],
      ...(row.eligibilityPresentationPolicyId
        ? { eligibilityPresentationPolicyId: row.eligibilityPresentationPolicyId }
        : {}),
      createdAt: row.createdAt,
      ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}),
    };
  }

  private toTransaction(
    row: typeof issuanceTransactions.$inferSelect,
  ): IssuanceTransactionRecord {
    return {
      id: row.id,
      tenantId: row.tenantId,
      policyId: row.policyId,
      policyVersion: row.policyVersion,
      credentialTypeId: row.credentialTypeId,
      state: row.state as IssuanceState,
      ...(row.businessReference ? { businessReference: row.businessReference } : {}),
      subjectReference: row.subjectReference,
      ...(row.authenticSourceKind ? { authenticSourceKind: row.authenticSourceKind } : {}),
      ...(row.eligibilityReason ? { eligibilityReason: row.eligibilityReason } : {}),
      ...(row.engineSessionRef ? { engineSessionRef: row.engineSessionRef } : {}),
      ...(row.engineTenantRef ? { engineTenantRef: row.engineTenantRef } : {}),
      ...(row.sentWithoutRegistrationCertificate !== null
        ? { sentWithoutRegistrationCertificate: row.sentWithoutRegistrationCertificate }
        : {}),
      ...(row.callbackUrl ? { callbackUrl: row.callbackUrl } : {}),
      deliveryStatus: row.deliveryStatus,
      ...(row.failureCode ? { failureCode: row.failureCode } : {}),
      ...(row.failureMessage ? { failureMessage: row.failureMessage } : {}),
      ...(row.providerSideFailure !== null
        ? { providerSideFailure: row.providerSideFailure }
        : {}),
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
