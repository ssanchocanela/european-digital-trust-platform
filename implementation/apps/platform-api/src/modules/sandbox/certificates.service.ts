import { createHash, type KeyObject, X509Certificate } from "node:crypto";
import type { RegisteredCredential as DomainCredential } from "@edtp/domain";
import type {
  SandboxCertificateRecord,
  SandboxCertificateRepository,
  SandboxRepository,
  SandboxServiceRole,
} from "@edtp/persistence";
import {
  failedChecks,
  isAcceptableDnsName,
  issueWrpac,
  issueWrprc,
  type RegisteredCredential,
  readCertificationRequest,
  serialToHex,
  toPem,
  validateWrpac,
  validateWrprc,
  WRPAC_VARIANT_INFO,
  WRPRC_VARIANT_INFO,
  type WrpacVariant,
  type WrprcVariant,
} from "@edtp/sandbox-pki";
import { asId, type Clock, newUuid, PlatformError, type TenantId } from "@edtp/shared";
import type { AuditService } from "../audit/audit.service.js";
import type { RegistrationService } from "../registration/registration.service.js";
import type { SandboxPublicationService } from "./publication.service.js";
import type { SandboxService, SignedInContext } from "./sandbox.service.js";
import type { SandboxTrustDomain } from "./trust-domain.runtime.js";
import type { SandboxUrls } from "./urls.js";

/**
 * The sandbox's certificate service (S3, specification J3, J4, J7, ADR 0014): a participant's
 * services and intended uses, and the access and registration certificates the sandbox issues for
 * them — correct, or with a chosen defect from the catalogue (§5).
 *
 * Take-away access certificates only, in S3: issued against a certification request, so the
 * participant's key never reaches the sandbox. The *hosted* access certificate is issued when a
 * hosted verifier or issuer is provisioned (S4, S5), its key generated and handed to the engine in
 * the same call.
 *
 * Every certificate is self-tested on issue against the catalogue: the response says which check it
 * fails, by design — never what a wallet will do (§5.4).
 */
export const PID_TYPE_SD_JWT = "urn:eudi:pid:1";
const SANDBOX_REGISTRAR = "EDTP Sandbox (TEST)";

export interface NewService {
  readonly role: SandboxServiceRole;
  readonly tradeName: string;
  readonly description: readonly { lang: string; value: string }[];
  readonly supportUri: string;
  readonly privacyPolicyUri: string;
  readonly infoUri: string;
}

export interface NewIntendedUse {
  readonly purpose: readonly { lang: string; value: string }[];
  readonly credentials: readonly RegisteredCredential[];
}

const fingerprint = (der: Buffer) =>
  createHash("sha256").update(der).digest("hex").toUpperCase();

export class SandboxCertificateService {
  constructor(
    private readonly sandbox: SandboxService,
    private readonly people: SandboxRepository,
    private readonly repository: SandboxCertificateRepository,
    private readonly registration: RegistrationService,
    private readonly domain: SandboxTrustDomain,
    private readonly publications: SandboxPublicationService,
    private readonly urls: SandboxUrls,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private async organisationOf(context: SignedInContext, tenantId: string) {
    const membership = this.sandbox.membershipIn(context, tenantId);
    const organisation = await this.people.findOrganisation(membership.tenantId);
    const platform = await this.repository.organisationIdOf(membership.tenantId);
    if (!organisation || !platform) throw PlatformError.notFound("Organisation");
    if (organisation.status !== "ACTIVE") {
      throw PlatformError.forbidden(
        "sandbox_organisation_suspended",
        "The organisation is suspended.",
      );
    }
    return { tenantId: membership.tenantId, organisation, ...platform };
  }

  // --- services and intended uses --------------------------------------------------------------

  async createService(context: SignedInContext, tenantId: string, input: NewService) {
    const org = await this.organisationOf(context, tenantId);
    let relyingPartyId = await this.repository.relyingPartyOf(org.tenantId);
    if (!relyingPartyId) {
      // The sandbox is the registrar here: the Relying Party identifier it assigns is the
      // organisation's `SB:` identifier, the one every certificate carries (Reg_32, RPRC_07).
      const rp = await this.registration.createRelyingParty({
        tenantId: org.tenantId,
        organisationId: asId<"OrganisationId">(org.organisationId),
        registrarAssignedIdentifier: org.organisation.localIdentifier,
        registrar: SANDBOX_REGISTRAR,
        registryUri: this.urls.registryEntry(org.organisation.localIdentifier),
        trustEnvironment: "TEST",
      });
      relyingPartyId = rp.id;
    }
    const count = await this.repository.countServices(org.tenantId);
    // Unique within the organisation (Reg_33), assigned by the sandbox.
    const serviceIdentifier = `S${String(count + 1).padStart(3, "0")}`;
    const { service } = await this.registration.createRelyingPartyService({
      tenantId: org.tenantId,
      relyingPartyId: asId<"RelyingPartyId">(relyingPartyId),
      serviceIdentifier,
      serviceTradeName: input.tradeName,
      description: input.description,
      callbackUrlAllowList: [],
    });
    await this.repository.createServiceRecord({
      relyingPartyServiceId: service.id,
      tenantId: org.tenantId,
      role: input.role,
      supportUri: input.supportUri,
      privacyPolicyUri: input.privacyPolicyUri,
      infoUri: input.infoUri,
      createdAt: this.clock.now(),
    });
    return this.service(context, tenantId, service.id);
  }

  async services(context: SignedInContext, tenantId: string) {
    const org = await this.organisationOf(context, tenantId);
    return this.repository.services(org.tenantId);
  }

  async service(context: SignedInContext, tenantId: string, serviceId: string) {
    const org = await this.organisationOf(context, tenantId);
    const service = await this.repository.service(org.tenantId, serviceId);
    if (!service) throw PlatformError.notFound("Service");
    const uses = await this.repository.intendedUsesOf(org.tenantId, serviceId);
    return {
      ...service,
      intendedUses: uses.map((u) => ({
        id: u.id,
        intendedUseIdentifier: u.intendedUseIdentifier,
        purpose: u.purpose,
        registeredCredentials: u.registeredCredentials,
      })),
    };
  }

  async addIntendedUse(
    context: SignedInContext,
    tenantId: string,
    serviceId: string,
    input: NewIntendedUse,
  ) {
    const org = await this.organisationOf(context, tenantId);
    const service = await this.repository.service(org.tenantId, serviceId);
    if (!service) throw PlatformError.notFound("Service");
    if (service.role !== "service_provider") {
      // EW-DM-44-009 (RPRC_05): no intended use for a provider.
      throw PlatformError.conflict(
        "sandbox_intended_use_not_for_provider",
        "A PID Provider service has no intended use.",
      );
    }
    const existing = await this.repository.intendedUsesOf(org.tenantId, serviceId);
    const use = await this.registration.createIntendedUse({
      tenantId: org.tenantId,
      relyingPartyServiceId: asId<"RelyingPartyServiceId">(serviceId),
      intendedUseIdentifier: `${service.serviceIdentifier}-U${String(existing.length + 1).padStart(2, "0")}`,
      purpose: input.purpose,
      privacyPolicyUris: [{ lang: "en", value: service.privacyPolicyUri }],
      registeredCredentials: input.credentials.map(
        (c): DomainCredential =>
          c.format === "dc+sd-jwt"
            ? {
                format: c.format,
                vctValues: [...c.types],
                claims: c.claims as DomainCredential["claims"],
              }
            : {
                format: c.format,
                doctype: c.types[0] as string,
                claims: c.claims as DomainCredential["claims"],
              },
      ),
    });
    return use;
  }

  // --- certificates ----------------------------------------------------------------------------

  private wrpacSubject(
    org: Awaited<ReturnType<SandboxCertificateService["organisationOf"]>>,
    service: { serviceIdentifier: string; serviceTradeName: string; supportUri: string },
    dnsNames: readonly string[],
  ) {
    return {
      legalName: org.legalName,
      tradeName: service.serviceTradeName,
      country: org.organisation.country,
      localIdentifier: org.organisation.localIdentifier,
      serviceIdentifier: service.serviceIdentifier,
      supportUri: service.supportUri,
      dnsNames,
    };
  }

  /** A take-away access certificate against the participant's request (specification J4). */
  async issueAccessCertificate(
    context: SignedInContext,
    tenantId: string,
    serviceId: string,
    input: {
      readonly variant: WrpacVariant;
      readonly csrPem: string;
      readonly dnsNames: readonly string[];
    },
  ) {
    let publicKey: KeyObject;
    try {
      publicKey = readCertificationRequest(pemToDer(input.csrPem, "CERTIFICATE REQUEST"));
    } catch (error) {
      throw PlatformError.validation(
        "invalid_certification_request",
        `The certification request was refused: ${error instanceof Error ? error.message : "unreadable"}.`,
      );
    }
    return this.issueAccessCertificateFor(context, tenantId, serviceId, {
      variant: input.variant,
      publicKey,
      dnsNames: input.dnsNames,
      mode: "takeaway",
    });
  }

  /**
   * An access certificate for a key the caller already holds: a take-away request's, or a hosted
   * verifier's, generated for the engine (S4).
   */
  async issueAccessCertificateFor(
    context: SignedInContext,
    tenantId: string,
    serviceId: string,
    input: {
      readonly variant: WrpacVariant;
      readonly publicKey: KeyObject;
      readonly dnsNames: readonly string[];
      readonly mode: "takeaway" | "hosted";
    },
  ) {
    const org = await this.organisationOf(context, tenantId);
    const service = await this.repository.service(org.tenantId, serviceId);
    if (!service) throw PlatformError.notFound("Service");
    const dnsNames = [...new Set(input.dnsNames.map((d) => d.trim().toLowerCase()))];
    if (dnsNames.length === 0 || dnsNames.length > 5 || !dnsNames.every(isAcceptableDnsName)) {
      throw PlatformError.validation(
        "invalid_dns_names",
        "Give one to five DNS names: lower-case host names, no wildcard, no address.",
      );
    }
    const publicKey = input.publicKey;
    const info = WRPAC_VARIANT_INFO[input.variant];
    const now = this.clock.now();
    const { der, serial } = issueWrpac({
      variant: input.variant,
      subject: this.wrpacSubject(org, service, dnsNames),
      subjectPublicKey: publicKey,
      issuer: {
        name: this.domain.name(info.issuer),
        signer: await this.domain.signer(info.issuer),
      },
      urls: {
        cps: this.urls.cps,
        crl: this.urls.crl(info.issuer),
        caIssuers: this.urls.caCertificate(info.issuer),
        register: this.urls.register,
      },
      now,
    });
    const x = new X509Certificate(der);
    const record: SandboxCertificateRecord = {
      id: newUuid(),
      tenantId: org.tenantId,
      relyingPartyServiceId: serviceId,
      kind: "WRPAC",
      variant: input.variant,
      issuerKey: info.issuer,
      serialHex: serialToHex(serial),
      notBefore: new Date(x.validFrom),
      notAfter: new Date(x.validTo),
      body: toPem(der, "CERTIFICATE"),
      fingerprintSha256: fingerprint(der),
      dnsNames,
      createdAt: now,
      mode: input.mode,
    };
    await this.repository.createCertificate(record);
    await this.audit.record({
      tenantId: org.tenantId,
      actor: "sandbox",
      action: "sandbox.access_certificate.issued",
      subjectType: "sandbox_certificate",
      subjectId: record.id,
    });
    // AC-04 is a correct certificate, revoked: the defect is the revocation.
    if (input.variant === "AC-04") await this.revokeRecord(record, now);
    return this.view(org.tenantId, record.id);
  }

  /** A registration certificate for a service, or for one of its intended uses (specification J4, J7). */
  async issueRegistrationCertificate(
    context: SignedInContext,
    tenantId: string,
    serviceId: string,
    input: { readonly variant: WrprcVariant; readonly intendedUseId?: string },
  ) {
    const org = await this.organisationOf(context, tenantId);
    const service = await this.repository.service(org.tenantId, serviceId);
    if (!service) throw PlatformError.notFound("Service");
    const info = WRPRC_VARIANT_INFO[input.variant];
    if (info.appliesTo !== "both" && info.appliesTo !== service.role) {
      throw PlatformError.conflict(
        "sandbox_variant_not_applicable",
        `${input.variant} does not apply to this kind of service.`,
      );
    }
    const uses = await this.repository.intendedUsesOf(org.tenantId, serviceId);
    const use =
      service.role === "service_provider"
        ? uses.find((u) => u.id === input.intendedUseId)
        : undefined;
    if (service.role === "service_provider" && !use) {
      // RPRC_09: one registration certificate per intended use × Service.
      throw PlatformError.validation(
        "intended_use_required",
        "Choose the intended use this certificate registers.",
      );
    }
    const now = this.clock.now();
    const signingKey = `${info.signer}-signing`;
    const statusIndex = await this.repository.nextStatusIndex();
    let body: string | undefined;
    if (input.variant !== "RC-01") {
      body = issueWrprc({
        variant: input.variant,
        kind: service.role,
        organisation: {
          legalName: org.legalName,
          tradeName: service.serviceTradeName,
          country: org.organisation.country,
          localIdentifier: org.organisation.localIdentifier,
          isPublicSectorBody: false,
        },
        service: { identifier: service.serviceIdentifier, description: service.description },
        ...(use
          ? {
              intendedUse: {
                identifier: use.intendedUseIdentifier,
                purpose: use.purpose as { lang: string; value: string }[],
                credentials: (use.registeredCredentials as DomainCredential[]).map((c) => ({
                  format: c.format,
                  types:
                    c.format === "dc+sd-jwt" ? [...(c.vctValues ?? [])] : [c.doctype ?? ""],
                  claims: c.claims as RegisteredCredential["claims"],
                })),
              },
            }
          : {}),
        providesAttestations:
          service.role === "pid_provider"
            ? [{ format: "dc+sd-jwt", type: PID_TYPE_SD_JWT }]
            : [],
        urls: {
          registry: this.urls.registryEntry(org.organisation.localIdentifier),
          info: service.infoUri,
          support: service.supportUri,
          privacyPolicy: service.privacyPolicyUri,
          certificatePolicy: this.urls.cps,
          unreachableStatus: this.urls.unavailableStatus,
        },
        status: { index: statusIndex, uri: this.urls.statusList(signingKey) },
        now,
        signer: await this.domain.signer(signingKey),
        chain: this.domain.chainOf(signingKey),
      });
    }
    const record: SandboxCertificateRecord = {
      id: newUuid(),
      tenantId: org.tenantId,
      relyingPartyServiceId: serviceId,
      ...(use ? { intendedUseId: use.id } : {}),
      kind: "WRPRC",
      variant: input.variant,
      issuerKey: signingKey,
      statusIndex,
      ...(body ? { body, fingerprintSha256: fingerprint(Buffer.from(body)) } : {}),
      dnsNames: [],
      createdAt: now,
      // A registration certificate has no key; it is always the participant's to download.
      mode: "takeaway",
    };
    await this.repository.createCertificate(record);
    await this.audit.record({
      tenantId: org.tenantId,
      actor: "sandbox",
      action: "sandbox.registration_certificate.issued",
      subjectType: "sandbox_certificate",
      subjectId: record.id,
    });
    if (input.variant === "RC-07") await this.revokeRecord(record, now);
    return this.view(org.tenantId, record.id);
  }

  async certificates(context: SignedInContext, tenantId: string, serviceId?: string) {
    const org = await this.organisationOf(context, tenantId);
    const records = await this.repository.certificates(org.tenantId, serviceId);
    return records.map((r) => this.describe(r));
  }

  async certificate(context: SignedInContext, tenantId: string, id: string) {
    const org = await this.organisationOf(context, tenantId);
    return this.view(org.tenantId, id);
  }

  async revoke(context: SignedInContext, tenantId: string, id: string) {
    const org = await this.organisationOf(context, tenantId);
    const record = await this.repository.certificate(org.tenantId, id);
    if (!record) throw PlatformError.notFound("Certificate");
    if (record.revokedAt)
      throw PlatformError.conflict(
        "sandbox_certificate_revoked",
        "Already revoked; revocation is final.",
      );
    await this.revokeRecord(record, this.clock.now());
    return this.view(org.tenantId, id);
  }

  private async revokeRecord(record: SandboxCertificateRecord, at: Date) {
    await this.repository.revoke(record.tenantId, record.id, at);
    await this.audit.record({
      tenantId: record.tenantId,
      actor: "sandbox",
      action: "sandbox.certificate.revoked",
      subjectType: "sandbox_certificate",
      subjectId: record.id,
    });
    await this.publications.publishIfNeeded(
      record.kind === "WRPAC" ? `crl:${record.issuerKey}` : `status:${record.issuerKey}`,
    );
  }

  /** The record as stored, for the hosted verifier: it needs the PEM chain and the WRPRC body. */
  async record(tenantId: TenantId, id: string): Promise<SandboxCertificateRecord | undefined> {
    return this.repository.certificate(tenantId, id);
  }

  /** The certificate view the portal shows: description, body and the sandbox's own check. */
  async describeById(tenantId: TenantId, id: string) {
    return this.view(tenantId, id);
  }

  private describe(record: SandboxCertificateRecord) {
    const info =
      record.kind === "WRPAC"
        ? WRPAC_VARIANT_INFO[record.variant as WrpacVariant]
        : WRPRC_VARIANT_INFO[record.variant as WrprcVariant];
    return {
      id: record.id,
      serviceId: record.relyingPartyServiceId,
      ...(record.intendedUseId ? { intendedUseId: record.intendedUseId } : {}),
      kind: record.kind,
      variant: record.variant,
      variantTitle: info.title,
      requirement: info.requirement,
      ...("walletCoreReason" in info && info.walletCoreReason
        ? { walletCoreReason: info.walletCoreReason }
        : {}),
      ...("issuanceSide" in info && info.issuanceSide ? { issuanceSide: true } : {}),
      ...(record.notBefore ? { notBefore: record.notBefore } : {}),
      ...(record.notAfter ? { notAfter: record.notAfter } : {}),
      ...(record.fingerprintSha256 ? { fingerprintSha256: record.fingerprintSha256 } : {}),
      dnsNames: record.dnsNames,
      createdAt: record.createdAt,
      mode: record.mode,
      ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
    };
  }

  /** The record, its body, and the sandbox's own check of it. */
  private async view(tenantId: TenantId, id: string) {
    const record = await this.repository.certificate(tenantId, id);
    if (!record) throw PlatformError.notFound("Certificate");
    return {
      ...this.describe(record),
      ...(record.body ? { body: record.body } : {}),
      selfTest: await this.selfTest(record),
    };
  }

  /**
   * The sandbox's own check of a certificate it issued (specification §5.4): which check it fails,
   * and whether that is the one its variant is built to fail. Not a wallet's verdict.
   */
  private async selfTest(record: SandboxCertificateRecord) {
    const now = this.clock.now();
    if (record.kind === "WRPAC") {
      const info = WRPAC_VARIANT_INFO[record.variant as WrpacVariant];
      const der = pemToDer(record.body ?? "", "CERTIFICATE");
      const results = validateWrpac(der, {
        trustedCa: this.domain.x509("access-ca"),
        revokedSerials: new Set(record.revokedAt && record.serialHex ? [record.serialHex] : []),
        expectedDnsNames: record.dnsNames,
        at: now,
      });
      const fails = failedChecks(results);
      return { fails, asDesigned: sameChecks(fails, info.fails) };
    }
    const info = WRPRC_VARIANT_INFO[record.variant as WrprcVariant];
    if (!record.body) return { fails: ["present"], asDesigned: info.fails === "present" };
    const service = await this.repository.service(
      record.tenantId,
      record.relyingPartyServiceId,
    );
    // The binding is checked against the access certificate the organisation's identifier would be in.
    const access = (
      await this.repository.certificates(record.tenantId, record.relyingPartyServiceId)
    ).find((c) => c.kind === "WRPAC" && c.variant === "AC-00");
    const uses = service
      ? await this.repository.intendedUsesOf(record.tenantId, service.relyingPartyServiceId)
      : [];
    const use = uses.find((u) => u.id === record.intendedUseId);
    const requested = use
      ? (use.registeredCredentials as DomainCredential[]).flatMap((c) =>
          c.claims.map((path) => ({
            format: c.format,
            type: c.format === "dc+sd-jwt" ? (c.vctValues?.[0] ?? "") : (c.doctype ?? ""),
            path: path as (string | number | null)[],
          })),
        )
      : undefined;
    const results = validateWrprc(record.body, {
      trustedRegistrar: this.domain.x509("registrar"),
      accessCertificate: access?.body
        ? new X509Certificate(access.body)
        : syntheticBindingCertificate(this.domain),
      at: now,
      kind: service?.role ?? "service_provider",
      statusOf: (uri) =>
        uri === this.urls.unavailableStatus
          ? "unreachable"
          : record.revokedAt
            ? "revoked"
            : "valid",
      ...(requested ? { requested } : {}),
      ...(service?.role === "pid_provider" ? { issuedType: PID_TYPE_SD_JWT } : {}),
    });
    // Without a correct access certificate the binding cannot be checked: leave it out, and say so.
    const fails = failedChecks(results).filter(
      (c) => access || c !== "bound_to_access_certificate",
    );
    return {
      fails,
      asDesigned: sameChecks(fails, info.fails),
      ...(access ? {} : { bindingNotChecked: true }),
    };
  }
}

const sameChecks = (fails: readonly string[], expected?: string) =>
  expected ? fails.length === 1 && fails[0] === expected : fails.length === 0;

/** A stand-in used only to run the other WRPRC checks when no correct access certificate exists. */
function syntheticBindingCertificate(domain: SandboxTrustDomain): X509Certificate {
  return domain.x509("access-ca");
}

export function pemToDer(pem: string, label: string): Buffer {
  const match = new RegExp(
    `-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`,
  ).exec(pem);
  if (!match?.[1]) throw new Error(`not a PEM ${label.toLowerCase()}`);
  return Buffer.from(match[1].replace(/\s+/g, ""), "base64");
}
