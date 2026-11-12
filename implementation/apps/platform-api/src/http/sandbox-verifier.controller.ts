import { RUN_OBSERVATIONS } from "@edtp/persistence";
import { WRPAC_VARIANTS, WRPRC_VARIANTS } from "@edtp/sandbox-pki";
import { newCorrelationId, PlatformError } from "@edtp/shared";
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { z } from "zod";
import type { PlatformConfig } from "../config.js";
import type { SandboxService } from "../modules/sandbox/sandbox.service.js";
import type { SandboxVerifierService } from "../modules/sandbox/verifier.service.js";
import { CONFIG_TOKEN, SANDBOX_SERVICE, SANDBOX_VERIFIER } from "../tokens.js";
import { assertUuidPathParam, constantTimeEquals, Public } from "./auth.js";
import { SANDBOX_PORTAL_SECRET_HEADER, SANDBOX_SESSION_HEADER } from "./sandbox.controllers.js";

const configureSchema = z
  .object({
    accessVariant: z.enum(WRPAC_VARIANTS),
    uses: z
      .array(
        z
          .object({
            intendedUseId: z.string().uuid(),
            registrationVariant: z.enum(WRPRC_VARIANTS),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();
const runSchema = z
  .object({
    intendedUseId: z.string().uuid(),
    interaction: z.enum(["SAME_DEVICE", "QR"]).default("SAME_DEVICE"),
  })
  .strict();
const observationSchema = z
  .object({
    walletBuild: z.string().trim().min(1).max(100),
    checkRegistrationCertificates: z.enum(["on", "off", "unknown"]),
    observation: z.enum(RUN_OBSERVATIONS),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

/**
 * The hosted verifier and its runs (S4, specification J5 and §6), for the sandbox portal. Same access
 * rule as the rest of `/sandbox/v1`.
 */
@ApiExcludeController()
@Public()
@Controller("sandbox/v1/organisations/:organisationId")
export class SandboxVerifierController {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: PlatformConfig,
    @Inject(SANDBOX_SERVICE) private readonly sandbox: SandboxService | undefined,
    @Inject(SANDBOX_VERIFIER) private readonly verifier: SandboxVerifierService | undefined,
  ) {}

  private async auth(
    secret: string | undefined,
    session: string | undefined,
    organisationId: string,
  ) {
    const expected = this.config.SANDBOX_PORTAL_SECRET;
    if (!this.sandbox || !this.verifier || !expected) throw PlatformError.notFound("Route");
    if (!secret || !constantTimeEquals(secret, expected)) throw PlatformError.unauthenticated();
    if (!session) throw PlatformError.unauthenticated();
    assertUuidPathParam("organisationId", organisationId);
    return { context: await this.sandbox.authenticate(session), verifier: this.verifier };
  }

  @Get("services/:serviceId/verifier")
  async view(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("serviceId") serviceId: string,
  ) {
    const { context, verifier } = await this.auth(secret, session, org);
    assertUuidPathParam("serviceId", serviceId);
    return verifier.view(context, org, serviceId);
  }

  @Post("services/:serviceId/verifier")
  @HttpCode(200)
  async configure(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("serviceId") serviceId: string,
    @Body() body: unknown,
  ) {
    const { context, verifier } = await this.auth(secret, session, org);
    assertUuidPathParam("serviceId", serviceId);
    return verifier.configure(context, org, serviceId, configureSchema.parse(body ?? {}));
  }

  @Post("services/:serviceId/runs")
  @HttpCode(201)
  async start(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("serviceId") serviceId: string,
    @Body() body: unknown,
  ) {
    const { context, verifier } = await this.auth(secret, session, org);
    assertUuidPathParam("serviceId", serviceId);
    const input = runSchema.parse(body ?? {});
    return verifier.startRun(context, org, serviceId, {
      ...input,
      correlationId: newCorrelationId(),
    });
  }

  @Get("runs")
  async runs(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
  ) {
    const { context, verifier } = await this.auth(secret, session, org);
    return verifier.runs(context, org);
  }

  @Get("runs/:runId")
  async run(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("runId") runId: string,
  ) {
    const { context, verifier } = await this.auth(secret, session, org);
    assertUuidPathParam("runId", runId);
    return verifier.run(context, org, runId, newCorrelationId());
  }

  @Post("runs/:runId/observation")
  @HttpCode(204)
  async observe(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("runId") runId: string,
    @Body() body: unknown,
  ) {
    const { context, verifier } = await this.auth(secret, session, org);
    assertUuidPathParam("runId", runId);
    const input = observationSchema.parse(body ?? {});
    await verifier.observe(context, org, runId, {
      ...input,
      ...(input.note ? { note: input.note } : {}),
    });
  }
}
