import type {
  SandboxCertificateRepository,
  SandboxWalletProviderRepository,
  WalletProviderAnchor,
} from "@edtp/persistence";
import { inspectWalletProviderAnchor } from "@edtp/sandbox-pki";
import { asId, type Clock, newUuid, PlatformError } from "@edtp/shared";
import type { AuditService } from "../audit/audit.service.js";
import type { SandboxPublicationService } from "./publication.service.js";
import type { SandboxService, SignedInContext } from "./sandbox.service.js";
import type { SandboxTrustDomain } from "./trust-domain.runtime.js";

/** At most this many pending or approved anchors per Wallet Provider service: current and next. */
export const WALLET_PROVIDER_ANCHORS_PER_SERVICE = 2;

const WALLET_PROVIDERS_CHANNEL = "lote:WalletProviders";

const REFUSALS: Record<string, string> = {
  contains_private_key: "That contains a private key. Upload the public certificate only.",
  not_one_certificate: "Upload exactly one PEM certificate.",
  unparseable: "That is not a readable X.509 certificate.",
  expired: "The certificate has expired.",
  not_yet_valid: "The certificate is not valid yet.",
  validity_too_long: "The certificate is valid for more than 20 years.",
  unsupported_key: "The key must be EC P-256 or P-384, or RSA of at least 3072 bits.",
  ca_without_key_cert_sign: "A CA certificate must allow certificate signing (keyCertSign).",
  leaf_without_digital_signature:
    "A signing certificate must allow digital signatures (digitalSignature).",
};

/**
 * Wallet Providers bring their own anchors (ADR 0020): the public certificate their wallet
 * attestations chain to, or are signed with. An anchor is pending until the operator approves it, and
 * only approved anchors of active organisations reach the `WalletProviders` list and, through it, the
 * hosted PID issuers. Sign-in never trusts it (ADR 0015 Decision 2): the list is a participant source.
 */
export class SandboxWalletProviderService {
  constructor(
    private readonly sandbox: SandboxService,
    private readonly services: SandboxCertificateRepository,
    private readonly repository: SandboxWalletProviderRepository,
    private readonly domain: SandboxTrustDomain,
    private readonly publications: SandboxPublicationService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private async walletProviderService(
    context: SignedInContext,
    orgId: string,
    serviceId: string,
    owner: boolean,
  ) {
    const membership = await this.sandbox.activeMembershipIn(context, orgId);
    if (owner && membership.role !== "owner") {
      throw PlatformError.forbidden("sandbox_owner_required", "Only an owner can do this.");
    }
    const service = await this.services.service(membership.tenantId, serviceId);
    if (!service) throw PlatformError.notFound("Service");
    if (service.role !== "wallet_provider") {
      throw PlatformError.conflict(
        "sandbox_not_a_wallet_provider",
        "Anchors belong to a Wallet Provider service.",
      );
    }
    return { tenantId: membership.tenantId, serviceId };
  }

  private view(a: WalletProviderAnchor) {
    return {
      id: a.id,
      kind: a.kind,
      fingerprint: a.fingerprint,
      subject: a.subject,
      notAfter: a.notAfter,
      status: a.status,
      ...(a.reason ? { reason: a.reason } : {}),
      createdAt: a.createdAt,
      ...(a.decidedAt ? { decidedAt: a.decidedAt } : {}),
    };
  }

  async anchors(context: SignedInContext, orgId: string, serviceId: string) {
    const { tenantId } = await this.walletProviderService(context, orgId, serviceId, false);
    return (await this.repository.ofService(tenantId, serviceId)).map((a) => this.view(a));
  }

  async upload(context: SignedInContext, orgId: string, serviceId: string, pem: string) {
    const { tenantId } = await this.walletProviderService(context, orgId, serviceId, true);
    const now = this.clock.now();
    const inspected = inspectWalletProviderAnchor(pem, now);
    if (!inspected.ok) {
      throw PlatformError.validation(
        `wallet_provider_anchor_${inspected.refusal}`,
        REFUSALS[inspected.refusal] ?? "The certificate was refused.",
      );
    }
    const anchor = inspected.anchor;
    const operatorPlaced = this.domain.walletProviderAnchors.some((a) =>
      a.certificate.equals(anchor.der),
    );
    if (operatorPlaced || (await this.repository.isLive(anchor.fingerprint))) {
      throw PlatformError.conflict(
        "wallet_provider_anchor_duplicate",
        "That certificate is already on the list, or waiting for approval.",
      );
    }
    if (
      (await this.repository.countLive(tenantId, serviceId)) >=
      WALLET_PROVIDER_ANCHORS_PER_SERVICE
    ) {
      throw PlatformError.conflict(
        "sandbox_quota_exceeded",
        `A Wallet Provider service holds at most ${WALLET_PROVIDER_ANCHORS_PER_SERVICE} anchors. Withdraw one first.`,
      );
    }
    const record: WalletProviderAnchor = {
      id: newUuid(),
      tenantId,
      relyingPartyServiceId: serviceId,
      kind: anchor.kind,
      certificateDer: anchor.der.toString("base64"),
      fingerprint: anchor.fingerprint,
      subject: anchor.subject.slice(0, 500),
      notAfter: anchor.notAfter,
      status: "PENDING",
      createdAt: now,
    };
    await this.repository.create(record);
    await this.audit.record({
      tenantId,
      actor: "sandbox",
      action: "sandbox.wallet_provider_anchor.uploaded",
      subjectType: "sandbox_wallet_provider_anchor",
      subjectId: record.id,
    });
    return this.view(record);
  }

  async withdraw(context: SignedInContext, orgId: string, serviceId: string, anchorId: string) {
    const { tenantId } = await this.walletProviderService(context, orgId, serviceId, true);
    const anchor = await this.repository.find(anchorId);
    if (!anchor || anchor.tenantId !== tenantId || anchor.relyingPartyServiceId !== serviceId) {
      throw PlatformError.notFound("Anchor");
    }
    if (
      !(await this.repository.decide(
        anchorId,
        ["PENDING", "APPROVED"],
        "WITHDRAWN",
        this.clock.now(),
      ))
    ) {
      throw PlatformError.conflict(
        "wallet_provider_anchor_not_live",
        "That anchor is not live.",
      );
    }
    await this.audit.record({
      tenantId,
      actor: "sandbox",
      action: "sandbox.wallet_provider_anchor.withdrawn",
      subjectType: "sandbox_wallet_provider_anchor",
      subjectId: anchorId,
    });
    if (anchor.status === "APPROVED")
      await this.publications.publishIfNeeded(WALLET_PROVIDERS_CHANNEL);
  }

  // --- the operator (ADR 0019, ADR 0020 §3) -------------------------------------------------------

  private operator(context: SignedInContext): string {
    if (!this.sandbox.isOperator(context)) throw PlatformError.notFound("Route");
    return `sandbox-operator:${context.person.id}`;
  }

  async all(context: SignedInContext) {
    this.operator(context);
    return (await this.repository.all()).map((a) => ({
      ...this.view(a),
      organisation: a.organisation,
      organisationStatus: a.organisationStatus,
      serviceId: a.relyingPartyServiceId,
    }));
  }

  async approve(context: SignedInContext, anchorId: string) {
    const actor = this.operator(context);
    const anchor = await this.repository.find(anchorId);
    if (!anchor) throw PlatformError.notFound("Anchor");
    if (anchor.notAfter.getTime() <= this.clock.now().getTime()) {
      throw PlatformError.conflict(
        "wallet_provider_anchor_expired",
        "The certificate has expired.",
      );
    }
    if (!(await this.repository.decide(anchorId, ["PENDING"], "APPROVED", this.clock.now()))) {
      throw PlatformError.conflict(
        "wallet_provider_anchor_not_pending",
        "That anchor is not pending.",
      );
    }
    await this.audit.record({
      tenantId: asId<"TenantId">(anchor.tenantId),
      actor,
      action: "sandbox.wallet_provider_anchor.approved",
      subjectType: "sandbox_wallet_provider_anchor",
      subjectId: anchorId,
    });
    await this.publications.publishIfNeeded(WALLET_PROVIDERS_CHANNEL);
  }

  async refuse(context: SignedInContext, anchorId: string, reason: string) {
    const actor = this.operator(context);
    const anchor = await this.repository.find(anchorId);
    if (!anchor) throw PlatformError.notFound("Anchor");
    if (
      !(await this.repository.decide(
        anchorId,
        ["PENDING"],
        "REFUSED",
        this.clock.now(),
        reason.slice(0, 200),
      ))
    ) {
      throw PlatformError.conflict(
        "wallet_provider_anchor_not_pending",
        "That anchor is not pending.",
      );
    }
    await this.audit.record({
      tenantId: asId<"TenantId">(anchor.tenantId),
      actor,
      action: "sandbox.wallet_provider_anchor.refused",
      subjectType: "sandbox_wallet_provider_anchor",
      subjectId: anchorId,
    });
  }
}
