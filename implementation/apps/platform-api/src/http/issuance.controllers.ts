import {
  validateCredentialType,
  validateIssuancePolicyVersion,
  validateWebhookEndpoint,
} from "@edtp/domain";
import type { EudiIssuerProvisioningPort } from "@edtp/eudi-issuer-port";
import type { IssuanceRepository, WebhookEndpointRepository } from "@edtp/persistence";
import { asId, newOpaqueToken, newWebhookEndpointId, PlatformError } from "@edtp/shared";
import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { IssuanceService } from "../modules/issuances/issuance.service.js";
import {
  FEATURE_PID_DURING_ISSUANCE,
  ISSUANCE_REPOSITORY,
  ISSUANCE_SERVICE,
  ISSUER_PROVISIONING_PORT,
  REGISTERED_CONNECTORS,
  REGISTERED_EVALUATORS,
  WEBHOOK_ENDPOINT_REPOSITORY,
} from "../tokens.js";
import { assertTenantMatches, Ctx, type RequestContext } from "./auth.js";
import {
  changeCredentialStatusSchema,
  createAttestationProviderSchema,
  createCredentialTypeSchema,
  createIssuancePolicySchema,
  createIssuancePolicyVersionSchema,
  createIssuanceSchema,
  provisionAttestationProviderSchema,
} from "./schemas.js";

/**
 * Issuance configuration: Attestation Providers, credential types, issuance policies.
 *
 * Business resources only, like the verification side. No OpenID4VCI, no credential offer, no
 * engine configuration object appears in any request or response here.
 */
@ApiTags("issuance-configuration")
@Controller("v1/tenants")
export class IssuanceConfigurationController {
  constructor(
    @Inject(ISSUANCE_REPOSITORY) private readonly issuance: IssuanceRepository,
    @Inject(WEBHOOK_ENDPOINT_REPOSITORY)
    private readonly endpoints: WebhookEndpointRepository,
    @Inject(ISSUER_PROVISIONING_PORT) private readonly provisioning: EudiIssuerProvisioningPort,
    @Inject(REGISTERED_EVALUATORS) private readonly evaluators: readonly string[],
    @Inject(REGISTERED_CONNECTORS) private readonly connectors: readonly string[],
    @Inject(FEATURE_PID_DURING_ISSUANCE) private readonly pidDuringIssuanceEnabled: boolean,
  ) {}

  @Post(":tenantId/attestation-providers")
  @ApiOperation({ summary: "Register an Organisation as an Attestation Provider (TEST)" })
  async createAttestationProvider(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const input = createAttestationProviderSchema.parse(body);

    if (input.trustEnvironment !== "TEST") {
      throw PlatformError.conflict(
        "trust_environment_unsupported",
        "V0 operates in the TEST trust environment only.",
      );
    }

    const created = await this.issuance.createAttestationProvider({
      tenantId: id,
      organisationId: input.organisationId,
      registrarAssignedIdentifier: input.registrarAssignedIdentifier,
      ...(input.registrar ? { registrar: input.registrar } : {}),
      trustEnvironment: input.trustEnvironment,
      at: new Date(),
    });

    return {
      attestationProviderId: created.id,
      registrarAssignedIdentifier: input.registrarAssignedIdentifier,
      trustEnvironment: input.trustEnvironment,
    };
  }

  @Post(":tenantId/attestation-providers/:providerId/provision")
  @ApiOperation({
    summary: "Provision the engine tenant, signing key and registration certificate",
  })
  async provision(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Param("providerId") providerId: string,
    @Body() body: unknown,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const input = provisionAttestationProviderSchema.parse(body);

    // The key passes through this process in memory only. What is stored is the opaque reference
    // the engine returns — there is no platform-side key to protect, dump or log.
    const imported = await this.provisioning.importSigningCertificate({
      engineTenantRef: input.engineTenantRef,
      name: `Attestation Provider ${providerId}`,
      privateKeyJwk: input.signingCertificate.privateKeyJwk,
      certificateChain: input.signingCertificate.certificateChain,
    });

    // The callback destination, when one is asked for. The same shared kernel object a Relying
    // Party Service references, so issuance reuses the Milestone 1 queue, signing, retry schedule
    // and SSRF check rather than growing a second delivery path.
    let webhookEndpointId: string | undefined;
    let webhookSecret: string | undefined;
    if (input.callbackUrlAllowList) {
      validateWebhookEndpoint({
        name: `Attestation Provider ${providerId}`,
        callbackUrlAllowList: input.callbackUrlAllowList,
      });
      const endpoint = {
        id: newWebhookEndpointId(),
        tenantId: id,
        name: `Attestation Provider ${providerId}`,
        callbackUrlAllowList: input.callbackUrlAllowList,
        createdAt: new Date(),
      };
      // Returned once, like the Relying Party Service secret. Never readable again.
      webhookSecret = newOpaqueToken(32);
      await this.endpoints.create({ endpoint, secret: webhookSecret });
      webhookEndpointId = endpoint.id;
    }

    await this.issuance.provisionAttestationProvider({
      tenantId: id,
      attestationProviderId: providerId,
      engineTenantRef: input.engineTenantRef,
      signingKeyBindingRef: imported.keyBindingRef,
      ...(input.registrationCertificateJwt
        ? { registrationCertificateJwt: input.registrationCertificateJwt }
        : {}),
      ...(webhookEndpointId ? { webhookEndpointId } : {}),
    });

    return {
      provisioned: true,
      keyBindingRef: imported.keyBindingRef,
      // Stated in the response, not only in a log: without it a Wallet cannot authenticate the
      // provider before issuance (ARF §6.6.2.2).
      registrationCertificatePublished: input.registrationCertificateJwt !== undefined,
      ...(webhookEndpointId ? { webhookEndpointId } : {}),
      // Shown once and never again, exactly as on the verification side.
      ...(webhookSecret ? { webhookSecret } : {}),
    };
  }

  @Get(":tenantId/attestation-providers/:providerId/provider-authentication")
  @ApiOperation({
    summary: "What a Wallet would see when authenticating this provider (ARF §6.6.2.2)",
  })
  async providerAuthentication(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Param("providerId") providerId: string,
  ) {
    assertTenantMatches(ctx, tenantId);
    const context = await this.issuance.loadIssuanceContextByProvider(
      asId<"TenantId">(tenantId),
      providerId,
    );
    const engineTenantRef = context.engineTenantRef;
    if (!engineTenantRef) {
      throw PlatformError.conflict(
        "attestation_provider_not_provisioned",
        "The Attestation Provider has no engine tenant yet.",
      );
    }

    const evidence =
      await this.provisioning.fetchProviderAuthenticationEvidence(engineTenantRef);
    return {
      credentialIssuer: evidence.credentialIssuer,
      registrationCertificatePresent: evidence.registrationCertificatePresent,
      metadataSigned: evidence.metadataSigned,
      accessCertificateInSignedMetadata: evidence.accessCertificateInSignedMetadata,
      registrationCertificateInSignedPayload: evidence.registrationCertificateInSignedPayload,
      credentialConfigurationIds: evidence.credentialConfigurationIds,
      // The honest assessment, returned rather than implied — and all three conditions, not two.
      //
      // ETSI TS 119 472-3 V1.1.1 makes gate (a) one mechanism: the metadata is signed
      // (`ISS-MDATA-4.2.1-01`) by the provider's **access certificate** (`-02`), which travels in the
      // `x5c` protected header (`ISS-MDATA-ACC_CERT-4.2.2-01/-02`), and the registration certificate
      // sits in `issuer_info` at the top level of that signed payload
      // (`ISS-MDATA-REG_CERT-4.2.3-02`). A registration certificate in the *unsigned* document does
      // not satisfy it.
      //
      // All four flags are false at the pinned engine version, so today this would be false however
      // it were written. It is written in full so that an engine release adding `signed_metadata`
      // cannot make this claim true while the access certificate is still missing.
      walletCanAuthenticateProvider:
        evidence.metadataSigned &&
        evidence.accessCertificateInSignedMetadata &&
        evidence.registrationCertificateInSignedPayload,
    };
  }

  @Post(":tenantId/credential-types")
  @ApiOperation({ summary: "Define a credential type and the Rulebook that governs it" })
  async createCredentialType(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const input = createCredentialTypeSchema.parse(body);

    // Refuses rather than repairs: an unverifiable type must not exist to be referenced.
    validateCredentialType({
      format: input.format,
      ...(input.vct ? { vct: input.vct } : {}),
      ...(input.doctype ? { doctype: input.doctype } : {}),
      rulebook: input.rulebook,
      claims: input.claims,
      display: input.display,
      validitySeconds: input.validitySeconds,
      statusMechanism: input.statusMechanism,
    });

    const created = await this.issuance.createCredentialType({
      tenantId: id,
      type: {
        attestationProviderId: input.attestationProviderId,
        name: input.name,
        format: input.format,
        ...(input.vct ? { vct: input.vct } : {}),
        ...(input.doctype ? { doctype: input.doctype } : {}),
        rulebook: input.rulebook,
        claims: input.claims,
        display: input.display,
        validitySeconds: input.validitySeconds,
        statusMechanism: input.statusMechanism,
        requiresKeyBinding: input.requiresKeyBinding,
      },
      at: new Date(),
    });

    return { credentialTypeId: created.id, name: input.name, format: input.format };
  }

  @Get(":tenantId/credential-types/:credentialTypeId")
  @ApiOperation({ summary: "Read a credential type" })
  async getCredentialType(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Param("credentialTypeId") credentialTypeId: string,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const type = await this.issuance.findCredentialType(id, credentialTypeId);
    if (!type) throw PlatformError.notFound("Credential type");
    return type;
  }

  @Post(":tenantId/issuance-policies")
  @ApiOperation({ summary: "Create an issuance policy" })
  async createPolicy(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const input = createIssuancePolicySchema.parse(body);
    const policy = await this.issuance.createPolicy({
      tenantId: id,
      credentialTypeId: input.credentialTypeId,
      name: input.name,
      at: new Date(),
    });
    return { policyId: policy.id, name: policy.name, status: policy.status };
  }

  @Get(":tenantId/issuance-policies/:policyId")
  @ApiOperation({ summary: "Read an issuance policy and its versions" })
  async getPolicy(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Param("policyId") policyId: string,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const policy = await this.issuance.findPolicy(id, policyId);
    if (!policy) throw PlatformError.notFound("Issuance policy");
    const versions = await this.issuance.listVersions(id, policyId);
    return { ...policy, versions };
  }

  @Post(":tenantId/issuance-policies/:policyId/versions")
  @ApiOperation({ summary: "Create, and optionally publish, an issuance policy version" })
  async createVersion(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Param("policyId") policyId: string,
    @Body() body: unknown,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const input = createIssuancePolicyVersionSchema.parse(body);

    const type = await this.issuance.findCredentialType(id, input.credentialTypeId);
    if (!type) throw PlatformError.notFound("Credential type");

    // The gate is at **publication**, not at issuance: a policy that cannot run must not become
    // publishable and then fail when a User is waiting. Same reasoning as the evaluator/connector
    // name checks.
    if (input.eligibilityPresentationPolicyId && !this.pidDuringIssuanceEnabled) {
      throw PlatformError.conflict(
        "feature_pid_during_issuance_disabled",
        "eligibilityPresentationPolicyId requires FEATURE_PID_DURING_ISSUANCE=true. The flow is " +
          "wired and the engine supports it, but it has not been exercised end to end with a " +
          "wallet, so it is off by default rather than shipped unverified.",
      );
    }

    // Validated at publication, against the type it issues. Catching a contradiction here costs
    // nothing; catching it during an issuance means a User has already been asked to accept
    // something the platform cannot deliver.
    validateIssuancePolicyVersion(
      {
        credentialTypeId: input.credentialTypeId,
        purpose: input.purpose,
        eligibilityRule: input.eligibilityRule,
        authenticSource: input.authenticSource,
        holderBinding: input.holderBinding,
        flow: input.flow,
        credentialValiditySeconds: input.credentialValiditySeconds,
        statusPolicy: input.statusPolicy,
        retentionPolicy: input.retentionPolicy,
        ...(input.eligibilityPresentationPolicyId
          ? { eligibilityPresentationPolicyId: input.eligibilityPresentationPolicyId }
          : {}),
      },
      {
        credentialType: type,
        registeredEvaluators: this.evaluators,
        registeredConnectors: this.connectors,
        at: new Date(),
      },
    );

    const created = await this.issuance.createVersion({
      tenantId: id,
      policyId,
      body: {
        credentialTypeId: input.credentialTypeId,
        purpose: input.purpose,
        eligibilityRule: input.eligibilityRule,
        authenticSource: input.authenticSource,
        holderBinding: input.holderBinding,
        flow: input.flow,
        credentialValiditySeconds: input.credentialValiditySeconds,
        statusPolicy: input.statusPolicy,
        retentionPolicy: input.retentionPolicy,
        ...(input.eligibilityPresentationPolicyId
          ? { eligibilityPresentationPolicyId: input.eligibilityPresentationPolicyId }
          : {}),
      },
      publish: input.publish,
      at: new Date(),
    });

    return {
      policyId,
      version: created.version,
      status: created.status,
      publishedAt: created.publishedAt,
    };
  }
}

/** Issuance transactions and the status of what was issued. */
@ApiTags("issuances")
@Controller("v1")
export class IssuanceController {
  constructor(@Inject(ISSUANCE_SERVICE) private readonly issuances: IssuanceService) {}

  @Post("issuances")
  @ApiOperation({ summary: "Create an issuance and obtain a credential offer" })
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const input = createIssuanceSchema.parse(body);
    return this.issuances.create({
      tenantId: ctx.tenantId,
      policyId: input.policyId,
      subjectReference: input.subjectReference,
      ...(input.businessReference ? { businessReference: input.businessReference } : {}),
      ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
    });
  }

  @Get("issuances/:issuanceId")
  @ApiOperation({ summary: "Read an issuance transaction" })
  async get(@Ctx() ctx: RequestContext, @Param("issuanceId") issuanceId: string) {
    return this.issuances.get(ctx.tenantId, issuanceId);
  }

  @Post("issued-credentials/:issuedCredentialId/revoke")
  @ApiOperation({
    summary: "Revoke an issued attestation. Irreversible — `AS-AP-07-007` (`VCR_04`)",
  })
  async revoke(
    @Ctx() ctx: RequestContext,
    @Param("issuedCredentialId") issuedCredentialId: string,
  ) {
    return this.issuances.changeCredentialStatus({
      tenantId: ctx.tenantId,
      issuedCredentialId,
      to: "REVOKED",
    });
  }

  @Post("issued-credentials/:issuedCredentialId/status")
  @ApiOperation({
    summary: "Suspend or reinstate an issued attestation. `VALID` only from `SUSPENDED`",
  })
  async changeStatus(
    @Ctx() ctx: RequestContext,
    @Param("issuedCredentialId") issuedCredentialId: string,
    @Body() body: unknown,
  ) {
    const input = changeCredentialStatusSchema.parse(body);
    return this.issuances.changeCredentialStatus({
      tenantId: ctx.tenantId,
      issuedCredentialId,
      to: input.status,
    });
  }
}
