import { WRPAC_VARIANTS, WRPRC_VARIANTS } from "@edtp/sandbox-pki";
import { PlatformError } from "@edtp/shared";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { z } from "zod";
import type { PlatformConfig } from "../config.js";
import type { SandboxCertificateService } from "../modules/sandbox/certificates.service.js";
import type { SandboxService } from "../modules/sandbox/sandbox.service.js";
import { CONFIG_TOKEN, SANDBOX_CERTIFICATES, SANDBOX_SERVICE } from "../tokens.js";
import { assertUuidPathParam, constantTimeEquals, Public } from "./auth.js";
import { SANDBOX_PORTAL_SECRET_HEADER, SANDBOX_SESSION_HEADER } from "./sandbox.controllers.js";

const localised = z
  .array(
    z
      .object({
        lang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
        value: z.string().trim().min(1).max(500),
      })
      .strict(),
  )
  .min(1)
  .max(10);
const httpsUri = z
  .string()
  .url()
  .max(500)
  .refine((u) => u.startsWith("https://"), "must be https");
const supportUri = z
  .string()
  .max(500)
  .refine(
    (u) => /^https:\/\/\S+$/.test(u) || /^mailto:[^\s@]+@[^\s@]+$/.test(u),
    "must be https or mailto",
  );
const claimPath = z
  .array(z.union([z.string().min(1).max(100), z.number().int().min(0), z.null()]))
  .min(1)
  .max(10);

const serviceSchema = z
  .object({
    role: z.enum(["service_provider", "pid_provider"]),
    tradeName: z.string().trim().min(1).max(200),
    description: localised,
    supportUri,
    privacyPolicyUri: httpsUri,
    infoUri: httpsUri,
  })
  .strict();

const intendedUseSchema = z
  .object({
    purpose: localised,
    credentials: z
      .array(
        z
          .object({
            format: z.enum(["dc+sd-jwt", "mso_mdoc"]),
            types: z.array(z.string().min(1).max(200)).min(1).max(5),
            claims: z.array(claimPath).min(1).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();

const accessSchema = z
  .object({
    variant: z.enum(WRPAC_VARIANTS),
    csrPem: z.string().min(100).max(12_000),
    dnsNames: z.array(z.string().min(1).max(253)).min(1).max(5),
  })
  .strict();

const registrationSchema = z
  .object({ variant: z.enum(WRPRC_VARIANTS), intendedUseId: z.string().uuid().optional() })
  .strict();

/**
 * The sandbox portal's routes for services, intended uses and certificates (S3, specification J3,
 * J4, J7). Same access rule as the rest of `/sandbox/v1`: the portal secret, a person's session, and
 * the organisation in the path checked against that person's memberships.
 */
@ApiExcludeController()
@Public()
@Controller("sandbox/v1/organisations/:organisationId")
export class SandboxCertificatesController {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: PlatformConfig,
    @Inject(SANDBOX_SERVICE) private readonly sandbox: SandboxService | undefined,
    @Inject(SANDBOX_CERTIFICATES)
    private readonly certificates: SandboxCertificateService | undefined,
  ) {}

  private async auth(
    secret: string | undefined,
    session: string | undefined,
    organisationId: string,
  ) {
    const expected = this.config.SANDBOX_PORTAL_SECRET;
    if (!this.sandbox || !this.certificates || !expected) throw PlatformError.notFound("Route");
    if (!secret || !constantTimeEquals(secret, expected)) throw PlatformError.unauthenticated();
    if (!session) throw PlatformError.unauthenticated();
    assertUuidPathParam("organisationId", organisationId);
    return {
      context: await this.sandbox.authenticate(session),
      certificates: this.certificates,
    };
  }

  @Get("services")
  async services(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
  ) {
    const { context, certificates } = await this.auth(secret, session, org);
    return certificates.services(context, org);
  }

  @Post("services")
  @HttpCode(201)
  async createService(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Body() body: unknown,
  ) {
    const { context, certificates } = await this.auth(secret, session, org);
    return certificates.createService(context, org, serviceSchema.parse(body ?? {}));
  }

  @Get("services/:serviceId")
  async service(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("serviceId") serviceId: string,
  ) {
    const { context, certificates } = await this.auth(secret, session, org);
    assertUuidPathParam("serviceId", serviceId);
    return certificates.service(context, org, serviceId);
  }

  @Post("services/:serviceId/intended-uses")
  @HttpCode(201)
  async addIntendedUse(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("serviceId") serviceId: string,
    @Body() body: unknown,
  ) {
    const { context, certificates } = await this.auth(secret, session, org);
    assertUuidPathParam("serviceId", serviceId);
    return certificates.addIntendedUse(
      context,
      org,
      serviceId,
      intendedUseSchema.parse(body ?? {}),
    );
  }

  @Post("services/:serviceId/access-certificates")
  @HttpCode(201)
  async issueAccess(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("serviceId") serviceId: string,
    @Body() body: unknown,
  ) {
    const { context, certificates } = await this.auth(secret, session, org);
    assertUuidPathParam("serviceId", serviceId);
    return certificates.issueAccessCertificate(
      context,
      org,
      serviceId,
      accessSchema.parse(body ?? {}),
    );
  }

  @Post("services/:serviceId/registration-certificates")
  @HttpCode(201)
  async issueRegistration(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("serviceId") serviceId: string,
    @Body() body: unknown,
  ) {
    const { context, certificates } = await this.auth(secret, session, org);
    assertUuidPathParam("serviceId", serviceId);
    const input = registrationSchema.parse(body ?? {});
    return certificates.issueRegistrationCertificate(context, org, serviceId, {
      variant: input.variant,
      ...(input.intendedUseId ? { intendedUseId: input.intendedUseId } : {}),
    });
  }

  @Get("certificates")
  async list(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Query("service") serviceId: string | undefined,
  ) {
    const { context, certificates } = await this.auth(secret, session, org);
    if (serviceId) assertUuidPathParam("service", serviceId);
    return certificates.certificates(context, org, serviceId);
  }

  @Get("certificates/:certificateId")
  async one(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("certificateId") id: string,
  ) {
    const { context, certificates } = await this.auth(secret, session, org);
    assertUuidPathParam("certificateId", id);
    return certificates.certificate(context, org, id);
  }

  @Post("certificates/:certificateId/revoke")
  @HttpCode(200)
  async revoke(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("certificateId") id: string,
  ) {
    const { context, certificates } = await this.auth(secret, session, org);
    assertUuidPathParam("certificateId", id);
    return certificates.revoke(context, org, id);
  }
}
