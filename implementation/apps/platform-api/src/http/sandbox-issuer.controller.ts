import { PID_VARIANTS, WRPRC_VARIANTS } from "@edtp/sandbox-pki";
import { PlatformError } from "@edtp/shared";
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { z } from "zod";
import type { PlatformConfig } from "../config.js";
import type { SandboxIssuerService } from "../modules/sandbox/issuer.service.js";
import type { SandboxService } from "../modules/sandbox/sandbox.service.js";
import { CONFIG_TOKEN, SANDBOX_ISSUER, SANDBOX_SERVICE } from "../tokens.js";
import { assertUuidPathParam, constantTimeEquals, Public } from "./auth.js";
import { SANDBOX_PORTAL_SECRET_HEADER, SANDBOX_SESSION_HEADER } from "./sandbox.controllers.js";

const SIGNING_VARIANTS = PID_VARIANTS.filter((v) => v !== "PID-03") as [
  "PID-00",
  "PID-01",
  "PID-02",
];

const configureSchema = z
  .object({
    signingVariant: z.enum(SIGNING_VARIANTS),
    registrationVariant: z.enum(WRPRC_VARIANTS),
  })
  .strict();

const name = z.string().trim().min(1).max(100);
const country = z.string().regex(/^[A-Z]{2}$/);
const offerSchema = z
  .object({
    givenName: name,
    familyName: name,
    birthdate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((d) => !Number.isNaN(Date.parse(d)), "not a date"),
    birthCountry: country,
    nationalities: z.array(country).min(1).max(5),
  })
  .strict();

/**
 * The hosted PID issuer (S5, specification J7 and J8), for the sandbox portal. Same access rule as
 * the rest of `/sandbox/v1`. The offer route takes synthetic values — content, never stored.
 */
@ApiExcludeController()
@Public()
@Controller("sandbox/v1/organisations/:organisationId")
export class SandboxIssuerController {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: PlatformConfig,
    @Inject(SANDBOX_SERVICE) private readonly sandbox: SandboxService | undefined,
    @Inject(SANDBOX_ISSUER) private readonly issuer: SandboxIssuerService | undefined,
  ) {}

  private async auth(
    secret: string | undefined,
    session: string | undefined,
    organisationId: string,
  ) {
    const expected = this.config.SANDBOX_PORTAL_SECRET;
    if (!this.sandbox || !this.issuer || !expected) throw PlatformError.notFound("Route");
    if (!secret || !constantTimeEquals(secret, expected)) throw PlatformError.unauthenticated();
    if (!session) throw PlatformError.unauthenticated();
    assertUuidPathParam("organisationId", organisationId);
    return { context: await this.sandbox.authenticate(session), issuer: this.issuer };
  }

  @Get("services/:serviceId/issuer")
  async view(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("serviceId") serviceId: string,
  ) {
    const { context, issuer } = await this.auth(secret, session, org);
    assertUuidPathParam("serviceId", serviceId);
    return issuer.view(context, org, serviceId);
  }

  @Post("services/:serviceId/issuer")
  @HttpCode(200)
  async configure(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("serviceId") serviceId: string,
    @Body() body: unknown,
  ) {
    const { context, issuer } = await this.auth(secret, session, org);
    assertUuidPathParam("serviceId", serviceId);
    return issuer.configure(context, org, serviceId, configureSchema.parse(body ?? {}));
  }

  @Post("services/:serviceId/issuer/offers")
  @HttpCode(201)
  async offer(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("serviceId") serviceId: string,
    @Body() body: unknown,
  ) {
    const { context, issuer } = await this.auth(secret, session, org);
    assertUuidPathParam("serviceId", serviceId);
    return issuer.offer(context, org, serviceId, offerSchema.parse(body ?? {}));
  }

  @Get("issuances/:issuanceId")
  async status(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("issuanceId") id: string,
  ) {
    const { context, issuer } = await this.auth(secret, session, org);
    assertUuidPathParam("issuanceId", id);
    return issuer.issuanceStatus(context, org, id);
  }

  @Post("issuances/:issuanceId/revoke")
  @HttpCode(200)
  async revoke(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("issuanceId") id: string,
  ) {
    const { context, issuer } = await this.auth(secret, session, org);
    assertUuidPathParam("issuanceId", id);
    return issuer.revoke(context, org, id);
  }
}
