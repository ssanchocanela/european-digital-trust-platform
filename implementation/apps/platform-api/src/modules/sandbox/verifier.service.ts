import { generateKeyPairSync, sign } from "node:crypto";
import type { RegisteredCredential as DomainCredential, ResultPolicy } from "@edtp/domain";
import type { EudiVerifierProvisioningPort } from "@edtp/eudi-verifier-port";
import type {
  RegistrationRepository,
  RunObservation,
  SandboxCertificateRepository,
  SandboxVerifierRepository,
} from "@edtp/persistence";
import {
  basicConstraints,
  issueCertificate,
  keyUsage,
  OID,
  randomSerial,
  toPem,
  WRPAC_VARIANT_INFO,
  WRPRC_VARIANT_INFO,
  type WrpacVariant,
  type WrprcVariant,
} from "@edtp/sandbox-pki";
import {
  asId,
  type Clock,
  type CorrelationId,
  newUuid,
  PlatformError,
  type TenantId,
} from "@edtp/shared";
import type { AuditService } from "../audit/audit.service.js";
import { EngineTenantService } from "../engine-tenants/engine-tenant.service.js";
import type { HostedFormReturns } from "../issuances/hosted-form-returns.js";
import type { PolicyService } from "../policies/policy.service.js";
import type { PresentationService } from "../presentations/presentation.service.js";
import type { RegistrationService } from "../registration/registration.service.js";
import type { SandboxCertificateService } from "./certificates.service.js";
import { assertQuota, quotaWindowStart } from "./quotas.js";
import type { SandboxService, SignedInContext } from "./sandbox.service.js";
import type { SandboxTrustDomain } from "./trust-domain.runtime.js";

/**
 * The hosted verifier (S4, specification J5): a Relying Party Instance of the participant's service,
 * on an engine tenant of its own created at runtime, presenting the certificates the participant
 * chose — correct or defective — and a run report for every presentation.
 *
 * Two deliberate departures from the platform's ordinary path, both for the defect catalogue:
 *
 * - **No validity is recorded on the platform's certificate rows.** The compiler refuses to send an
 *   access or registration certificate it knows has lapsed (`verification-plan.ts`); the sandbox's
 *   AC-02 and RC-05 exist to be sent. The sandbox keeps the validity in its own records.
 * - **RC-01 sends no registration certificate.** The request goes without `verifier_info`, which is
 *   exactly the defect.
 *
 * The result policy returns only which requested claims were present (`ClaimPresence`): the run
 * report needs to know a presentation worked, never what it said.
 */
export interface VerifierSettings {
  /** The host the engine's wallet-facing endpoints are reached at: the hosted WRPAC's `dNSName`. */
  readonly dnsName: string;
  readonly portalPublicUrl: string;
  /** The sandbox PID list's reference: the anchor source every sandbox policy names. */
  readonly pidListRef: string;
  /** The id of the engine-held list built from it, on every sandbox engine tenant. */
  readonly pidTrustListId: string;
}

const PID_VCT = "urn:eudi:pid:1";
const presenceClaim = (path: readonly (string | number | null)[]) =>
  `present_${path.map((p) => (p === null ? "any" : String(p))).join("_")}`.slice(0, 100);

export class SandboxVerifierService {
  constructor(
    private readonly settings: VerifierSettings,
    private readonly sandbox: SandboxService,
    private readonly certificates: SandboxCertificateService,
    private readonly sandboxCertificates: SandboxCertificateRepository,
    private readonly repository: SandboxVerifierRepository,
    private readonly registrationRepository: RegistrationRepository,
    private readonly registration: RegistrationService,
    private readonly policies: PolicyService,
    private readonly presentations: PresentationService,
    private readonly provisioning: EudiVerifierProvisioningPort,
    private readonly engineTenants: EngineTenantService | undefined,
    private readonly domain: SandboxTrustDomain,
    private readonly returns: HostedFormReturns,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private async serviceOf(context: SignedInContext, orgId: string, serviceId: string) {
    const membership = await this.sandbox.activeMembershipIn(context, orgId);
    const service = await this.sandboxCertificates.service(membership.tenantId, serviceId);
    if (!service) throw PlatformError.notFound("Service");
    if (service.role !== "service_provider") {
      throw PlatformError.conflict(
        "sandbox_not_a_relying_party",
        "Only a Relying Party service has a hosted verifier.",
      );
    }
    return { tenantId: membership.tenantId, service };
  }

  /** The PID issuers a sandbox verifier accepts: the sandbox PID CA and the sign-in anchors. */
  private async loadPidTrustList(engineTenantRef: string) {
    if (
      !this.provisioning.ensureTrustListSigningKey ||
      !this.provisioning.upsertIssuerTrustList
    ) {
      throw PlatformError.conflict(
        "sandbox_engine_lists_unsupported",
        "The engine adapter cannot load trust lists.",
      );
    }
    // The engine re-signs every list it holds with a key of its own; this one is the tenant's,
    // generated here and used for nothing else. Its private key goes to the engine and is dropped.
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const name = [
      { type: OID.organizationName, value: "EDTP Sandbox - TEST ONLY" },
      {
        type: OID.commonName,
        value: `EDTP Sandbox engine list key ${engineTenantRef} - TEST ONLY`,
      },
    ];
    const now = this.clock.now();
    const der = issueCertificate(
      {
        serial: randomSerial(),
        issuer: name,
        subject: name,
        notBefore: now,
        notAfter: new Date(now.getTime() + 730 * 86_400_000),
        subjectPublicKey: publicKey,
        extensions: [basicConstraints(false), keyUsage(["digitalSignature"])],
      },
      {
        publicKey,
        sign: (data) => sign("sha256", data, { key: privateKey, dsaEncoding: "der" }),
      },
    );
    await this.provisioning.ensureTrustListSigningKey(engineTenantRef, {
      description: "EDTP Sandbox engine list key (TEST)",
      privateKeyJwk: privateKey.export({ format: "jwk" }) as Record<string, unknown>,
      certificatePem: toPem(der, "CERTIFICATE"),
    });
    await this.provisioning.upsertIssuerTrustList(engineTenantRef, {
      listId: this.settings.pidTrustListId,
      description: "EDTP Sandbox PID Providers (TEST)",
      issuers: [
        {
          name: "EDTP Sandbox PID CA - TEST ONLY",
          certificatePem: toPem(this.domain.certificate("pid-ca"), "CERTIFICATE"),
        },
        ...this.domain.pidSignInAnchors.map((a) => ({
          name: a.name,
          certificatePem: toPem(a.certificate, "CERTIFICATE"),
        })),
      ],
    });
  }

  /**
   * Configure the hosted verifier: a fresh access certificate of the chosen variant, and for each
   * intended use a registration certificate of its chosen variant, swapped in for the next
   * presentation. The first configuration creates the engine tenant, its PID trust list and the
   * Relying Party Instance.
   */
  async configure(
    context: SignedInContext,
    orgId: string,
    serviceId: string,
    input: {
      readonly accessVariant: WrpacVariant;
      readonly uses: readonly {
        readonly intendedUseId: string;
        readonly registrationVariant: WrprcVariant;
      }[];
    },
  ) {
    const { tenantId, service } = await this.serviceOf(context, orgId, serviceId);
    const uses = await this.sandboxCertificates.intendedUsesOf(tenantId, serviceId);
    if (input.uses.length === 0) {
      throw PlatformError.validation(
        "intended_use_required",
        "Configure at least one intended use.",
      );
    }
    for (const u of input.uses) {
      if (!uses.some((x) => x.id === u.intendedUseId))
        throw PlatformError.notFound("Intended use");
      const applies = WRPRC_VARIANT_INFO[u.registrationVariant].appliesTo;
      if (applies === "pid_provider") {
        throw PlatformError.conflict(
          "sandbox_variant_not_applicable",
          `${u.registrationVariant} is for PID Providers.`,
        );
      }
    }
    const now = this.clock.now();
    let verifier = await this.repository.verifier(tenantId, serviceId);
    if (!verifier) {
      assertQuota(
        "hostedVerifiersPerOrganisation",
        await this.repository.countVerifiers(tenantId),
      );
    }
    const engineTenantRef =
      verifier?.engineTenantRef ?? (await this.createEngineTenant(service.serviceTradeName));

    // A key for the engine, and an access certificate for it.
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const access = await this.certificates.issueAccessCertificateFor(
      context,
      orgId,
      serviceId,
      {
        variant: input.accessVariant,
        publicKey,
        dnsNames: [this.settings.dnsName],
        mode: "hosted",
      },
    );
    const issuer = WRPAC_VARIANT_INFO[input.accessVariant].issuer;
    const chain = [
      access.body as string,
      toPem(this.domain.certificate(issuer), "CERTIFICATE"),
    ];
    const privateKeyJwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
    if (!verifier) {
      await this.registration.provisionInstance({
        tenantId,
        relyingPartyServiceId: asId<"RelyingPartyServiceId">(serviceId),
        engineTenantRef,
        trustEnvironment: "TEST",
        accessCertificate: { privateKeyJwk, certificateChain: chain },
      });
      await this.repository.createVerifier({
        relyingPartyServiceId: serviceId,
        tenantId,
        engineTenantRef,
        accessCertificateId: access.id,
        at: now,
      });
    } else {
      const { keyBindingRef } = await this.provisioning.importAccessCertificate({
        engineTenantRef,
        name: `sandbox ${input.accessVariant} for ${service.serviceIdentifier}`,
        privateKeyJwk,
        certificateChain: chain,
      });
      await this.registrationRepository.replaceAccessCertificate({
        id: asId<"AccessCertificateId">(newUuid()),
        tenantId,
        relyingPartyId: asId<"RelyingPartyId">(
          (await this.sandboxCertificates.relyingPartyOf(tenantId)) as string,
        ),
        relyingPartyServiceId: asId<"RelyingPartyServiceId">(serviceId),
        keyBindingRef,
        trustEnvironment: "TEST",
        createdAt: now,
      });
      await this.repository.setAccessCertificate(tenantId, serviceId, access.id, now);
    }

    for (const u of input.uses) {
      const wrprc = await this.certificates.issueRegistrationCertificate(
        context,
        orgId,
        serviceId,
        {
          variant: u.registrationVariant,
          intendedUseId: u.intendedUseId,
        },
      );
      const jwt = typeof wrprc.body === "string" ? wrprc.body : undefined;
      const replaced = await this.registrationRepository.replaceRegistrationCertificateJwt(
        tenantId,
        asId<"IntendedUseId">(u.intendedUseId),
        jwt,
      );
      if (!replaced) {
        await this.registration.recordRegistrationCertificate({
          tenantId,
          relyingPartyServiceId: asId<"RelyingPartyServiceId">(serviceId),
          intendedUseId: asId<"IntendedUseId">(u.intendedUseId),
          ...(jwt ? { jwt } : {}),
          provider: "EDTP Sandbox (TEST)",
          trustEnvironment: "TEST",
        });
      }
      verifier = await this.repository.verifier(tenantId, serviceId);
      const existing = verifier?.uses.find((x) => x.intendedUseId === u.intendedUseId);
      const policyId =
        existing?.policyId ??
        (await this.createPolicy(tenantId, serviceId, u.intendedUseId, uses));
      await this.repository.setUse({
        relyingPartyServiceId: serviceId,
        intendedUseId: u.intendedUseId,
        registrationCertificateId: wrprc.id,
        policyId,
        at: now,
      });
    }
    await this.audit.record({
      tenantId,
      actor: "sandbox",
      action: "sandbox.verifier.configured",
      subjectType: "relying_party_service",
      subjectId: serviceId,
      detail: { accessVariant: input.accessVariant, uses: input.uses.length },
    });
    return this.view(context, orgId, serviceId);
  }

  private async createEngineTenant(name: string): Promise<string> {
    if (!this.engineTenants) {
      throw PlatformError.conflict(
        "sandbox_engine_tenants_unavailable",
        "Hosted verifiers need runtime engine tenants, which are not configured.",
      );
    }
    const ref = EngineTenantService.newRef("sbx-rp");
    await this.engineTenants.create(ref, `Sandbox verifier: ${name}`.slice(0, 100));
    await this.loadPidTrustList(ref);
    return ref;
  }

  /** One policy per intended use: every registered claim requested, only presence returned. */
  private async createPolicy(
    tenantId: TenantId,
    serviceId: string,
    intendedUseId: string,
    uses: Awaited<ReturnType<SandboxCertificateRepository["intendedUsesOf"]>>,
  ): Promise<string> {
    const use = uses.find((u) => u.id === intendedUseId);
    if (!use) throw PlatformError.notFound("Intended use");
    const credential = (use.registeredCredentials as DomainCredential[])[0];
    if (
      !credential ||
      credential.format !== "dc+sd-jwt" ||
      !(credential.vctValues ?? []).includes(PID_VCT)
    ) {
      throw PlatformError.conflict(
        "sandbox_policy_pid_only",
        "The hosted verifier requests the PID in SD-JWT VC in v1.",
      );
    }
    const paths = credential.claims as (string | number | null)[][];
    const resultPolicy: ResultPolicy = {
      kind: "DERIVED_CLAIMS",
      derivations: paths.slice(0, 20).map((path) => ({
        name: "ClaimPresence" as const,
        sourcePath: path,
        outputClaim: presenceClaim(path),
      })),
    };
    const policy = await this.policies.createPolicy({
      tenantId,
      relyingPartyServiceId: asId<"RelyingPartyServiceId">(serviceId),
      intendedUseId: asId<"IntendedUseId">(intendedUseId),
      name: `Sandbox ${use.intendedUseIdentifier}`,
      description:
        "Sandbox hosted verifier: requests the registered claims, returns only their presence.",
    });
    await this.policies.createVersion({
      tenantId,
      policyId: policy.id,
      purpose: use.purpose as { lang: string; value: string }[],
      credentialRequirements: [{ credentialType: PID_VCT, acceptedFormats: ["dc+sd-jwt"] }],
      requestedClaims: paths.map((path) => ({ path })),
      resultPolicy,
      trustPolicy: {
        anchorSources: [
          {
            kind: "ETSI_TS_119_602_LOTE",
            domain: "PID_PROVIDER",
            ref: this.settings.pidListRef,
          },
        ],
        statusCheckMode: "STRICT",
      },
      publish: true,
    });
    return policy.id;
  }

  async view(context: SignedInContext, orgId: string, serviceId: string) {
    const { tenantId } = await this.serviceOf(context, orgId, serviceId);
    const verifier = await this.repository.verifier(tenantId, serviceId);
    if (!verifier) return { configured: false as const };
    const access = await this.certificates.describeById(tenantId, verifier.accessCertificateId);
    const uses = [];
    for (const u of verifier.uses) {
      uses.push({
        intendedUseId: u.intendedUseId,
        policyId: u.policyId,
        registrationCertificate: await this.certificates.describeById(
          tenantId,
          u.registrationCertificateId,
        ),
      });
    }
    return {
      configured: true as const,
      configuredAt: verifier.configuredAt,
      accessCertificate: access,
      uses,
    };
  }

  // --- runs ------------------------------------------------------------------------------------

  async startRun(
    context: SignedInContext,
    orgId: string,
    serviceId: string,
    input: {
      readonly intendedUseId: string;
      readonly interaction: "SAME_DEVICE" | "QR";
      readonly correlationId: CorrelationId;
    },
  ) {
    const { tenantId } = await this.serviceOf(context, orgId, serviceId);
    const verifier = await this.repository.verifier(tenantId, serviceId);
    const use = verifier?.uses.find((u) => u.intendedUseId === input.intendedUseId);
    assertQuota(
      "runsPerServicePerDay",
      await this.repository.countRunsSince(
        tenantId,
        serviceId,
        quotaWindowStart(this.clock.now()),
      ),
    );
    if (!verifier || !use) {
      throw PlatformError.conflict(
        "sandbox_verifier_not_configured",
        "Configure the hosted verifier for this intended use first.",
      );
    }
    const view = await this.presentations.create({
      tenantId,
      policyId: asId<"PresentationPolicyId">(use.policyId),
      businessReference: "sandbox-run",
      interactionType: input.interaction,
      correlationId: input.correlationId,
    });
    const runId = newUuid();
    await this.repository.createRun({
      id: runId,
      tenantId,
      relyingPartyServiceId: serviceId,
      intendedUseId: input.intendedUseId,
      presentationId: view.presentationId,
      accessCertificateId: verifier.accessCertificateId,
      registrationCertificateId: use.registrationCertificateId,
      interaction: input.interaction,
      createdAt: this.clock.now(),
    });
    if (input.interaction === "SAME_DEVICE") {
      const back = new URL(
        `org/${orgId}/runs/${runId}`,
        `${this.settings.portalPublicUrl.replace(/\/$/, "")}/`,
      );
      this.returns.remember(view.presentationId, back.toString(), view.expiresAt);
    }
    return {
      runId,
      walletUri: view.interaction?.uri,
      interaction: input.interaction,
      expiresAt: view.expiresAt,
    };
  }

  async run(
    context: SignedInContext,
    orgId: string,
    runId: string,
    correlationId: CorrelationId,
  ) {
    const membership = this.sandbox.membershipIn(context, orgId);
    const run = await this.repository.run(membership.tenantId, runId);
    if (!run) throw PlatformError.notFound("Run");
    const presentation = await this.presentations.get(
      membership.tenantId,
      asId<"PresentationId">(run.presentationId),
      correlationId,
    );
    const access = await this.certificates.describeById(
      membership.tenantId,
      run.accessCertificateId,
    );
    const registration = await this.certificates.describeById(
      membership.tenantId,
      run.registrationCertificateId,
    );
    return {
      id: run.id,
      createdAt: run.createdAt,
      interaction: run.interaction,
      // The platform's outcome: its state and failure code, never the engine's status (CLAUDE.md §6.5).
      outcome: {
        status: presentation.status,
        ...(presentation.failureCode ? { failureCode: presentation.failureCode } : {}),
        ...(presentation.sentWithoutRegistrationCertificate !== undefined
          ? {
              sentWithoutRegistrationCertificate:
                presentation.sentWithoutRegistrationCertificate,
            }
          : {}),
        ...(presentation.result ? { claimsPresent: presentation.result.claims } : {}),
      },
      accessCertificate: access,
      registrationCertificate: registration,
      expected: {
        access: {
          variant: access.variant,
          requirement: WRPAC_VARIANT_INFO[access.variant as WrpacVariant].requirement,
        },
        registration: {
          variant: registration.variant,
          requirement: WRPRC_VARIANT_INFO[registration.variant as WrprcVariant].requirement,
          registrationCheck:
            WRPRC_VARIANT_INFO[registration.variant as WrprcVariant].registrationCheck,
        },
      },
      observation: {
        ...(run.walletBuild ? { walletBuild: run.walletBuild } : {}),
        ...(run.checkRegistrationCertificates
          ? { checkRegistrationCertificates: run.checkRegistrationCertificates }
          : {}),
        ...(run.observation ? { observation: run.observation } : {}),
        ...(run.observationNote ? { note: run.observationNote } : {}),
        ...(run.observedAt ? { observedAt: run.observedAt } : {}),
      },
    };
  }

  async runs(context: SignedInContext, orgId: string) {
    const membership = this.sandbox.membershipIn(context, orgId);
    const runs = await this.repository.runs(membership.tenantId);
    return runs.map((r) => ({
      id: r.id,
      serviceId: r.relyingPartyServiceId,
      createdAt: r.createdAt,
      interaction: r.interaction,
      observed: Boolean(r.observedAt),
    }));
  }

  /** The tester's observation (specification §6). The note is their words; no credential value belongs in it. */
  async observe(
    context: SignedInContext,
    orgId: string,
    runId: string,
    input: {
      readonly walletBuild: string;
      readonly checkRegistrationCertificates: "on" | "off" | "unknown";
      readonly observation: RunObservation;
      readonly note?: string;
    },
  ) {
    const membership = this.sandbox.membershipIn(context, orgId);
    const saved = await this.repository.observe(membership.tenantId, runId, {
      walletBuild: input.walletBuild,
      checkRegistrationCertificates: input.checkRegistrationCertificates,
      observation: input.observation,
      ...(input.note ? { observationNote: input.note } : {}),
      at: this.clock.now(),
    });
    if (!saved) throw PlatformError.notFound("Run");
  }
}
