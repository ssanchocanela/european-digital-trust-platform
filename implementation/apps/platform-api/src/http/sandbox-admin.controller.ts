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
import type { SandboxAdminService } from "../modules/sandbox/admin.service.js";
import type { SandboxErasureService } from "../modules/sandbox/erasure.service.js";
import type { SandboxService } from "../modules/sandbox/sandbox.service.js";
import type { SandboxWalletProviderService } from "../modules/sandbox/wallet-provider.service.js";
import {
  CONFIG_TOKEN,
  SANDBOX_ADMIN,
  SANDBOX_ERASURE,
  SANDBOX_SERVICE,
  SANDBOX_WALLET_PROVIDERS,
} from "../tokens.js";
import { assertUuidPathParam, constantTimeEquals, Public } from "./auth.js";
import { SANDBOX_PORTAL_SECRET_HEADER, SANDBOX_SESSION_HEADER } from "./sandbox.controllers.js";

const suspendSchema = z.object({ reason: z.string().trim().min(3).max(200) }).strict();

/**
 * The operator's section of the sandbox portal (ADR 0019). Same access rule as every portal route —
 * the portal's secret, then a session the `SandboxAccessGuard` has bound to the Access identity —
 * and then the operator check in `SandboxAdminService`, which answers anyone else as not found.
 */
@ApiExcludeController()
@Public()
@Controller("sandbox/v1/admin")
export class SandboxAdminController {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: PlatformConfig,
    @Inject(SANDBOX_SERVICE) private readonly sandbox: SandboxService | undefined,
    @Inject(SANDBOX_ADMIN) private readonly admin: SandboxAdminService | undefined,
    @Inject(SANDBOX_ERASURE) private readonly erasure: SandboxErasureService | undefined,
  ) {}

  private erasureService(): SandboxErasureService {
    if (!this.erasure) throw PlatformError.notFound("Route");
    return this.erasure;
  }

  private async auth(secret: string | undefined, session: string | undefined) {
    const expected = this.config.SANDBOX_PORTAL_SECRET;
    if (!this.sandbox || !this.admin || !expected) throw PlatformError.notFound("Route");
    if (!secret || !constantTimeEquals(secret, expected)) throw PlatformError.unauthenticated();
    if (!session) throw PlatformError.unauthenticated();
    return { context: await this.sandbox.authenticate(session), admin: this.admin };
  }

  @Get("overview")
  async overview(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
  ) {
    const { context, admin } = await this.auth(secret, session);
    return admin.overview(context);
  }

  @Get("organisations")
  async organisations(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
  ) {
    const { context, admin } = await this.auth(secret, session);
    return admin.organisations(context);
  }

  @Get("organisations/:organisationId")
  async organisation(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") organisationId: string,
  ) {
    const { context, admin } = await this.auth(secret, session);
    assertUuidPathParam("organisationId", organisationId);
    return admin.organisation(context, organisationId);
  }

  @Post("organisations/:organisationId/suspend")
  @HttpCode(200)
  async suspend(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") organisationId: string,
    @Body() body: unknown,
  ) {
    const { context, admin } = await this.auth(secret, session);
    assertUuidPathParam("organisationId", organisationId);
    return admin.suspend(context, organisationId, suspendSchema.parse(body ?? {}).reason);
  }

  @Get("people")
  async people(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
  ) {
    const { context, admin } = await this.auth(secret, session);
    return admin.people(context);
  }

  @Post("people/:personId/end-sessions")
  @HttpCode(200)
  async endSessions(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("personId") personId: string,
  ) {
    const { context, admin } = await this.auth(secret, session);
    assertUuidPathParam("personId", personId);
    return admin.endSessions(context, personId);
  }

  @Get("people/:personId/erasure")
  async erasurePreview(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("personId") personId: string,
    @Query("override") override: string | undefined,
  ) {
    const { context } = await this.auth(secret, session);
    assertUuidPathParam("personId", personId);
    return this.erasureService().previewByOperator(context, personId, override === "true");
  }

  @Post("people/:personId/erase")
  @HttpCode(200)
  async erase(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("personId") personId: string,
    @Body() body: unknown,
  ) {
    const { context } = await this.auth(secret, session);
    assertUuidPathParam("personId", personId);
    const input = z
      .object({
        reason: z.string().trim().min(3).max(200),
        override: z.boolean().default(false),
      })
      .strict()
      .parse(body ?? {});
    return this.erasureService().eraseByOperator(
      context,
      personId,
      input.reason,
      input.override,
    );
  }

  @Get("invitations")
  async invitations(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
  ) {
    const { context, admin } = await this.auth(secret, session);
    return admin.invitations(context);
  }

  @Post("invitations/:invitationId/revoke")
  @HttpCode(204)
  async revokeInvitation(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("invitationId") invitationId: string,
  ) {
    const { context, admin } = await this.auth(secret, session);
    assertUuidPathParam("invitationId", invitationId);
    await admin.revokeInvitation(context, invitationId);
  }

  @Get("audit")
  async audit(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Query("organisation") organisation: string | undefined,
  ) {
    const { context, admin } = await this.auth(secret, session);
    if (organisation) assertUuidPathParam("organisation", organisation);
    return admin.auditTrail(context, organisation || undefined);
  }
}

const refuseSchema = z.object({ reason: z.string().trim().min(3).max(200) }).strict();

/** The operator's decisions on Wallet Provider anchors (ADR 0020 §3), under `/admin`. */
@ApiExcludeController()
@Public()
@Controller("sandbox/v1/admin/wallet-provider-anchors")
export class SandboxAdminWalletProviderController {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: PlatformConfig,
    @Inject(SANDBOX_SERVICE) private readonly sandbox: SandboxService | undefined,
    @Inject(SANDBOX_WALLET_PROVIDERS)
    private readonly walletProviders: SandboxWalletProviderService | undefined,
  ) {}

  private async auth(secret: string | undefined, session: string | undefined) {
    const expected = this.config.SANDBOX_PORTAL_SECRET;
    if (!this.sandbox || !this.walletProviders || !expected)
      throw PlatformError.notFound("Route");
    if (!secret || !constantTimeEquals(secret, expected)) throw PlatformError.unauthenticated();
    if (!session) throw PlatformError.unauthenticated();
    return { context: await this.sandbox.authenticate(session), wp: this.walletProviders };
  }

  @Get()
  async list(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
  ) {
    const { context, wp } = await this.auth(secret, session);
    return { anchors: await wp.all(context) };
  }

  @Post(":anchorId/approve")
  @HttpCode(204)
  async approve(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("anchorId") anchorId: string,
  ) {
    const { context, wp } = await this.auth(secret, session);
    assertUuidPathParam("anchorId", anchorId);
    await wp.approve(context, anchorId);
  }

  @Post(":anchorId/refuse")
  @HttpCode(204)
  async refuse(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("anchorId") anchorId: string,
    @Body() body: unknown,
  ) {
    const { context, wp } = await this.auth(secret, session);
    assertUuidPathParam("anchorId", anchorId);
    await wp.refuse(context, anchorId, refuseSchema.parse(body ?? {}).reason);
  }
}
