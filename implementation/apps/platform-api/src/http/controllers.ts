import type { EudiVerifierProvisioningPort } from "@edtp/eudi-verifier-port";
import { asId, PlatformError } from "@edtp/shared";
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { PolicyService } from "../modules/policies/policy.service.js";
import type { PresentationService } from "../modules/presentations/presentation.service.js";
import type { RegistrationService } from "../modules/registration/registration.service.js";
import {
  POLICY_SERVICE,
  PRESENTATION_SERVICE,
  REGISTRATION_SERVICE,
  VERIFIER_PROVISIONING_PORT,
} from "../tokens.js";
import {
  ADMIN_ONLY,
  AdminOnly,
  assertTenantMatches,
  assertUuidPathParam,
  Ctx,
  Public,
  type RequestContext,
} from "./auth.js";
import {
  createIntendedUseSchema,
  createOrganisationSchema,
  createPolicySchema,
  createPolicyVersionSchema,
  createPresentationSchema,
  createRelyingPartySchema,
  createRelyingPartyServiceSchema,
  createTenantSchema,
  provisionInstanceSchema,
  recordRegistrationCertificateSchema,
} from "./schemas.js";

/**
 * The public business API.
 *
 * Every resource here is a **business** resource. There is no DCQL, no OpenID4VP session,
 * no credential offer and no engine configuration object anywhere in a request or a
 * response: protocol details stay below the ports, and a boundary test asserts it.
 *
 * Tenancy comes from the authenticated credential. A `tenantId` in a path is checked
 * against it and never trusted (`assertTenantMatches`).
 */

@ApiTags("Tenants")
@Controller("v1/tenants")
export class TenantController {
  constructor(
    @Inject(REGISTRATION_SERVICE) private readonly registration: RegistrationService,
  ) {}

  /**
   * Creates a tenant and returns its API key.
   *
   * The only route reachable with the bootstrap administrative key. The returned key is
   * shown once and stored only as a hash.
   */
  @Post()
  @AdminOnly()
  @ApiOperation({ summary: "Create a tenant (administrative)" })
  async create(@Body() body: unknown) {
    const input = createTenantSchema.parse(body);
    const { tenant, apiKey } = await this.registration.createTenant(input.name);
    return {
      tenantId: tenant.id,
      name: tenant.name,
      createdAt: tenant.createdAt.toISOString(),
      apiKey,
      apiKeyNotice: "Store this key now. Only a hash is retained, so it cannot be shown again.",
    };
  }

  @Get(":tenantId")
  @ApiOperation({ summary: "Read a tenant" })
  async get(@Ctx() ctx: RequestContext, @Param("tenantId") tenantId: string) {
    const id = assertTenantMatches(ctx, tenantId);
    const tenant = await this.registration.getTenant(id);
    return {
      tenantId: tenant.id,
      name: tenant.name,
      createdAt: tenant.createdAt.toISOString(),
    };
  }

  @Post(":tenantId/organisations")
  @ApiOperation({ summary: "Register an Organisation" })
  async createOrganisation(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const input = createOrganisationSchema.parse(body);
    const organisation = await this.registration.createOrganisation({ tenantId: id, ...input });
    return {
      organisationId: organisation.id,
      legalName: organisation.legalName,
      memberState: organisation.memberState,
      isPublicSectorBody: organisation.isPublicSectorBody,
    };
  }

  /**
   * Records an Organisation's registration as a Relying Party.
   *
   * The Relying Party identifier is Registrar-assigned (ARF §3.11.1, `AS-MS-27-043` /
   * `Reg_32`) and is recorded here, never generated. V0 accepts `TEST` only.
   */
  @Post(":tenantId/relying-parties")
  @ApiOperation({ summary: "Register a Relying Party (TEST registration data)" })
  async createRelyingParty(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const input = createRelyingPartySchema.parse(body);
    const rp = await this.registration.createRelyingParty({
      tenantId: id,
      organisationId: asId<"OrganisationId">(input.organisationId),
      registrarAssignedIdentifier: input.registrarAssignedIdentifier,
      registrar: input.registrar,
      ...(input.registryUri ? { registryUri: input.registryUri } : {}),
      ...(input.tradeName ? { tradeName: input.tradeName } : {}),
      trustEnvironment: input.trustEnvironment,
    });
    return {
      relyingPartyId: rp.id,
      registrarAssignedIdentifier: rp.registrarAssignedIdentifier,
      registrar: rp.registrar,
      trustEnvironment: rp.trustEnvironment,
    };
  }

  @Post(":tenantId/rp-services")
  @ApiOperation({ summary: "Register a Relying Party Service" })
  async createService(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const input = createRelyingPartyServiceSchema.parse(body);
    const { service, webhookSecret } = await this.registration.createRelyingPartyService({
      tenantId: id,
      relyingPartyId: asId<"RelyingPartyId">(input.relyingPartyId),
      serviceIdentifier: input.serviceIdentifier,
      serviceTradeName: input.serviceTradeName,
      description: input.description,
      callbackUrlAllowList: input.callbackUrlAllowList,
    });
    return {
      serviceId: service.id,
      serviceIdentifier: service.serviceIdentifier,
      serviceTradeName: service.serviceTradeName,
      callbackUrlAllowList: service.callbackUrlAllowList,
      webhookSecret,
      webhookSecretNotice:
        "Store this secret now. It signs result callbacks and is not shown again.",
    };
  }

  @Get(":tenantId/rp-services/:serviceId")
  @ApiOperation({ summary: "Read a Relying Party Service" })
  async getService(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Param("serviceId") serviceId: string,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const service = await this.registration.getService(
      id,
      asId<"RelyingPartyServiceId">(serviceId),
    );
    return {
      serviceId: service.id,
      serviceIdentifier: service.serviceIdentifier,
      serviceTradeName: service.serviceTradeName,
      description: service.description,
      callbackUrlAllowList: service.callbackUrlAllowList,
    };
  }

  /**
   * Registers an intended use for a Service.
   *
   * `AS-MS-27-016` (`Reg_10d`): a Relying Party registers which intended uses apply to
   * each Service. `purpose` and `privacyPolicyUris` are localised and mandatory because
   * the Wallet displays both — `AS-WP-06-015` (`RPA_10`).
   */
  @Post(":tenantId/rp-services/:serviceId/intended-uses")
  @ApiOperation({ summary: "Register an intended use" })
  async createIntendedUse(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Param("serviceId") serviceId: string,
    @Body() body: unknown,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const input = createIntendedUseSchema.parse(body);
    const use = await this.registration.createIntendedUse({
      tenantId: id,
      relyingPartyServiceId: asId<"RelyingPartyServiceId">(serviceId),
      intendedUseIdentifier: input.intendedUseIdentifier,
      purpose: input.purpose,
      privacyPolicyUris: input.privacyPolicyUris,
      registeredCredentials: input.registeredCredentials,
      ...(input.validFrom ? { validFrom: input.validFrom } : {}),
    });
    return {
      intendedUseId: use.id,
      intendedUseIdentifier: use.intendedUseIdentifier,
      registeredCredentials: use.registeredCredentials,
    };
  }

  @Post(":tenantId/rp-services/:serviceId/registration-certificates")
  @ApiOperation({ summary: "Record a registration certificate for one intended use" })
  async recordRegistrationCertificate(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Param("serviceId") serviceId: string,
    @Body() body: unknown,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const input = recordRegistrationCertificateSchema.parse(body);
    await this.registration.recordRegistrationCertificate({
      tenantId: id,
      relyingPartyServiceId: asId<"RelyingPartyServiceId">(serviceId),
      intendedUseId: asId<"IntendedUseId">(input.intendedUseId),
      ...(input.jwt ? { jwt: input.jwt } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      trustEnvironment: input.trustEnvironment,
    });
    return {
      recorded: true,
      hasJwt: input.jwt !== undefined,
      notice: input.jwt
        ? undefined
        : "No registration certificate JWT was supplied, so presentation requests for this " +
          "intended use will be sent without one. The omission is reported on each transaction.",
    };
  }

  @Post(":tenantId/rp-services/:serviceId/instance")
  @ApiOperation({
    summary: "Provision the Relying Party Instance and import its access certificate",
  })
  async provisionInstance(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Param("serviceId") serviceId: string,
    @Body() body: unknown,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const input = provisionInstanceSchema.parse(body);
    const { keyBindingRef } = await this.registration.provisionInstance({
      tenantId: id,
      relyingPartyServiceId: asId<"RelyingPartyServiceId">(serviceId),
      engineTenantRef: input.engineTenantRef,
      trustEnvironment: input.trustEnvironment,
      accessCertificate: input.accessCertificate,
    });
    return { provisioned: true, keyBindingRef };
  }
}

@ApiTags("Presentation policies")
@Controller("v1/tenants/:tenantId/presentation-policies")
export class PolicyController {
  constructor(@Inject(POLICY_SERVICE) private readonly policies: PolicyService) {}

  @Post()
  @ApiOperation({ summary: "Create a presentation policy" })
  async create(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const input = createPolicySchema.parse(body);
    const policy = await this.policies.createPolicy({
      tenantId: id,
      relyingPartyServiceId: asId<"RelyingPartyServiceId">(input.relyingPartyServiceId),
      intendedUseId: asId<"IntendedUseId">(input.intendedUseId),
      name: input.name,
      description: input.description,
    });
    return { policyId: policy.id, name: policy.name, status: policy.status };
  }

  @Get(":policyId")
  @ApiOperation({ summary: "Read a presentation policy and its versions" })
  async get(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Param("policyId") policyId: string,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const { policy, versions } = await this.policies.getPolicy(
      id,
      asId<"PresentationPolicyId">(policyId),
    );
    return {
      policyId: policy.id,
      name: policy.name,
      description: policy.description,
      status: policy.status,
      relyingPartyServiceId: policy.relyingPartyServiceId,
      intendedUseId: policy.intendedUseId,
      versions: versions.map((v) => ({
        version: v.version,
        status: v.status,
        purpose: v.purpose,
        credentialRequirements: v.credentialRequirements,
        requestedClaims: v.requestedClaims,
        resultPolicy: v.resultPolicy,
        retentionPolicy: v.retentionPolicy,
        createdAt: v.createdAt.toISOString(),
        publishedAt: v.publishedAt?.toISOString(),
      })),
    };
  }

  /**
   * Creates a policy version.
   *
   * Validated against the registered intended use before it is stored. A request whose
   * claims are not within the registered attributes is refused with 422 and a `details`
   * entry naming every offending claim path.
   */
  @Post(":policyId/versions")
  @ApiOperation({ summary: "Create a presentation policy version" })
  async createVersion(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Param("policyId") policyId: string,
    @Body() body: unknown,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const input = createPolicyVersionSchema.parse(body);
    const version = await this.policies.createVersion({
      tenantId: id,
      policyId: asId<"PresentationPolicyId">(policyId),
      purpose: input.purpose,
      credentialRequirements: input.credentialRequirements,
      requestedClaims: input.requestedClaims,
      resultPolicy: input.resultPolicy,
      ...(input.trustPolicy ? { trustPolicy: input.trustPolicy } : {}),
      ...(input.retentionPolicy ? { retentionPolicy: input.retentionPolicy } : {}),
      publish: input.publish,
    });
    return {
      policyId: version.policyId,
      version: version.version,
      status: version.status,
      publishedAt: version.publishedAt?.toISOString(),
    };
  }

  @Post(":policyId/versions/:version/publish")
  @HttpCode(200)
  @ApiOperation({ summary: "Publish a draft policy version" })
  async publish(
    @Ctx() ctx: RequestContext,
    @Param("tenantId") tenantId: string,
    @Param("policyId") policyId: string,
    @Param("version") version: string,
  ) {
    const id = assertTenantMatches(ctx, tenantId);
    const parsed = Number.parseInt(version, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw PlatformError.validation(
        "invalid_version",
        "The version must be a positive integer.",
      );
    }
    await this.policies.publishVersion(id, asId<"PresentationPolicyId">(policyId), parsed);
    return { policyId, version: parsed, status: "PUBLISHED" };
  }
}

@ApiTags("Presentations")
@Controller("v1/presentations")
export class PresentationController {
  constructor(
    @Inject(PRESENTATION_SERVICE) private readonly presentations: PresentationService,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a presentation transaction" })
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const input = createPresentationSchema.parse(body);
    const view = await this.presentations.create({
      tenantId: ctx.tenantId,
      policyId: asId<"PresentationPolicyId">(input.policyId),
      ...(input.policyVersion !== undefined ? { policyVersion: input.policyVersion } : {}),
      businessReference: input.businessReference,
      ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
      interactionType: input.interactionType,
      correlationId: ctx.correlationId,
    });
    return {
      presentationId: view.presentationId,
      status: view.status,
      interaction: view.interaction,
      expiresAt: view.expiresAt.toISOString(),
      ...(view.sentWithoutRegistrationCertificate
        ? {
            warnings: [
              {
                code: "no_registration_certificate",
                message:
                  "The presentation request was sent without a registration certificate, " +
                  "because none is available for this intended use.",
              },
            ],
          }
        : {}),
    };
  }

  @Get(":presentationId")
  @ApiOperation({ summary: "Read a presentation transaction and its result" })
  async get(@Ctx() ctx: RequestContext, @Param("presentationId") presentationId: string) {
    assertUuidPathParam("presentationId", presentationId);
    const view = await this.presentations.get(
      ctx.tenantId,
      asId<"PresentationId">(presentationId),
      ctx.correlationId,
    );
    return toPresentationResponse(view);
  }

  @Post(":presentationId/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel a presentation transaction" })
  async cancel(@Ctx() ctx: RequestContext, @Param("presentationId") presentationId: string) {
    assertUuidPathParam("presentationId", presentationId);
    const view = await this.presentations.cancel(
      ctx.tenantId,
      asId<"PresentationId">(presentationId),
      ctx.correlationId,
    );
    return toPresentationResponse(view);
  }

  /**
   * Where the wallet returns the user after a same-device flow.
   *
   * Deliberately minimal and unauthenticated: it is reached by the user's browser, not by
   * the business client, so it reveals nothing. The business client reads the outcome
   * through the authenticated `GET` route.
   */
  @Get(":presentationId/return")
  @Public()
  @ApiExcludeEndpoint()
  async walletReturn(@Param("presentationId") presentationId: string) {
    // Unauthenticated and reached by a browser, so the least validated surface of the three — and the
    // one most likely to be poked at.
    assertUuidPathParam("presentationId", presentationId);
    return {
      presentationId,
      message: "The wallet interaction is complete. Return to the application to continue.",
    };
  }
}

const toPresentationResponse = (view: {
  presentationId: string;
  businessReference: string;
  status: string;
  policyId: string;
  policyVersion: number;
  expiresAt: Date;
  result?: { claims: Readonly<Record<string, unknown>> };
  failureCode?: string;
}) => ({
  presentationId: view.presentationId,
  businessReference: view.businessReference,
  status: view.status,
  policyId: view.policyId,
  policyVersion: view.policyVersion,
  expiresAt: view.expiresAt.toISOString(),
  // Present only on a VERIFIED outcome, and only what the result policy emitted.
  ...(view.result ? { result: view.result } : {}),
  ...(view.failureCode ? { failureCode: view.failureCode } : {}),
});

@ApiTags("Health")
@Controller()
export class HealthController {
  constructor(
    @Inject(VERIFIER_PROVISIONING_PORT)
    private readonly provisioning: EudiVerifierProvisioningPort,
  ) {}

  /**
   * Liveness and dependency check.
   *
   * Reports engine reachability but does not fail the platform when the engine is down:
   * configuration endpoints remain usable, and only presentation creation needs the engine.
   */
  @Get("health")
  @Public()
  @ApiOperation({ summary: "Health check" })
  async health() {
    const engineHealthy = await this.provisioning.healthy().catch(() => false);
    return {
      status: "ok",
      engine: engineHealthy ? "reachable" : "unreachable",
    };
  }
}

export const ADMIN_METADATA_KEY = ADMIN_ONLY;
