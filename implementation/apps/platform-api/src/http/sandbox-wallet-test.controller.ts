import { newCorrelationId, PlatformError } from "@edtp/shared";
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { z } from "zod";
import type { PlatformConfig } from "../config.js";
import type { SandboxService } from "../modules/sandbox/sandbox.service.js";
import {
  type SandboxWalletTestService,
  TESTER_OBSERVATIONS,
} from "../modules/sandbox/wallet-test.service.js";
import { CONFIG_TOKEN, SANDBOX_SERVICE, SANDBOX_WALLET_TESTS } from "../tokens.js";
import { assertUuidPathParam, constantTimeEquals, Public } from "./auth.js";
import { SANDBOX_PORTAL_SECRET_HEADER, SANDBOX_SESSION_HEADER } from "./sandbox.controllers.js";

const startSchema = z
  .object({
    serviceId: z.string().uuid(),
    planId: z.string().min(1).max(100),
    provider: z.string().trim().min(1).max(200),
    build: z.string().trim().min(1).max(200),
    platform: z.string().trim().min(1).max(100),
  })
  .strict();
const stepSchema = z
  .object({ interaction: z.enum(["SAME_DEVICE", "QR"]).default("SAME_DEVICE") })
  .strict();
const observeSchema = z
  .object({ observation: z.enum(TESTER_OBSERVATIONS), note: z.string().max(500).optional() })
  .strict();
const stepIndex = (raw: string) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 200) throw PlatformError.notFound("Step");
  return n;
};

/**
 * Wallet test plans (ADR 0022), for the portal: the plans, plan runs, their steps, the tester's
 * observations and the reports. Same access rule as the rest of `/sandbox/v1`.
 */
@ApiExcludeController()
@Public()
@Controller("sandbox/v1/organisations/:organisationId/wallet-tests")
export class SandboxWalletTestController {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: PlatformConfig,
    @Inject(SANDBOX_SERVICE) private readonly sandbox: SandboxService | undefined,
    @Inject(SANDBOX_WALLET_TESTS) private readonly tests: SandboxWalletTestService | undefined,
  ) {}

  private async auth(secret: string | undefined, session: string | undefined, org: string) {
    const expected = this.config.SANDBOX_PORTAL_SECRET;
    if (!this.sandbox || !this.tests || !expected) throw PlatformError.notFound("Route");
    if (!secret || !constantTimeEquals(secret, expected)) throw PlatformError.unauthenticated();
    if (!session) throw PlatformError.unauthenticated();
    assertUuidPathParam("organisationId", org);
    return { context: await this.sandbox.authenticate(session), tests: this.tests };
  }

  @Get()
  async list(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
  ) {
    const { context, tests } = await this.auth(secret, session, org);
    return { plans: tests.plans(), runs: await tests.runs(context, org) };
  }

  @Post()
  @HttpCode(201)
  async start(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Body() body: unknown,
  ) {
    const { context, tests } = await this.auth(secret, session, org);
    const input = startSchema.parse(body ?? {});
    return tests.start(context, org, input.serviceId, input.planId, input);
  }

  @Get(":planRunId")
  async report(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("planRunId") planRunId: string,
  ) {
    const { context, tests } = await this.auth(secret, session, org);
    assertUuidPathParam("planRunId", planRunId);
    return tests.report(context, org, planRunId, newCorrelationId());
  }

  @Get(":planRunId/signed")
  async signed(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("planRunId") planRunId: string,
  ) {
    const { context, tests } = await this.auth(secret, session, org);
    assertUuidPathParam("planRunId", planRunId);
    return { jws: await tests.signedReport(context, org, planRunId, newCorrelationId()) };
  }

  @Post(":planRunId/steps/:index")
  @HttpCode(201)
  async startStep(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("planRunId") planRunId: string,
    @Param("index") index: string,
    @Body() body: unknown,
  ) {
    const { context, tests } = await this.auth(secret, session, org);
    assertUuidPathParam("planRunId", planRunId);
    const { interaction } = stepSchema.parse(body ?? {});
    return tests.startStep(
      context,
      org,
      planRunId,
      stepIndex(index),
      interaction,
      newCorrelationId(),
    );
  }

  @Post(":planRunId/steps/:index/observation")
  @HttpCode(204)
  async observe(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") org: string,
    @Param("planRunId") planRunId: string,
    @Param("index") index: string,
    @Body() body: unknown,
  ) {
    const { context, tests } = await this.auth(secret, session, org);
    assertUuidPathParam("planRunId", planRunId);
    const input = observeSchema.parse(body ?? {});
    await tests.observe(
      context,
      org,
      planRunId,
      stepIndex(index),
      input.observation,
      input.note,
    );
  }
}
