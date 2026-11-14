import { newCorrelationId, PlatformError } from "@edtp/shared";
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { z } from "zod";
import type { PlatformConfig } from "../config.js";
import { SANDBOX_ACCESS_ASSERTION_HEADER } from "../modules/sandbox/access-identity.js";
import type { SandboxService, SignedInContext } from "../modules/sandbox/sandbox.service.js";
import { CONFIG_TOKEN, SANDBOX_SERVICE } from "../tokens.js";
import { assertUuidPathParam, constantTimeEquals, Public } from "./auth.js";

export const SANDBOX_PORTAL_SECRET_HEADER = "x-edtp-sandbox-portal-secret";
export const SANDBOX_SESSION_HEADER = "x-edtp-sandbox-session";

const token = z.string().min(20).max(200);

const startSchema = z
  .object({ interactionType: z.enum(["SAME_DEVICE", "QR"]).default("SAME_DEVICE") })
  .strict();

const bindingSchema = z.object({ bindingToken: token }).strict();

const organisationSchema = z
  .object({
    legalName: z.string().trim().min(1).max(200),
    tradeName: z.string().trim().min(1).max(200),
    country: z.string().regex(/^[A-Z]{2}$/),
    /** Declared, never verified, never in a certificate (ADR 0015 Decision 6). */
    declaredEuid: z.string().trim().min(3).max(100).optional(),
    isPublicSectorBody: z.boolean().default(false),
  })
  .strict();

const profileSchema = z
  .object({
    displayName: z.string().max(200),
    organisation: organisationSchema.optional(),
    invitationToken: token.optional(),
  })
  .strict();

const invitationSchema = z
  .object({
    role: z.enum(["owner", "member"]).default("member"),
    email: z.string().max(254),
  })
  .strict();
const acceptSchema = z.object({ invitationToken: token }).strict();
const apiKeySchema = z.object({ label: z.string().trim().min(1).max(100) }).strict();

/**
 * The sandbox portal's API (ADR 0015, ADR 0018).
 *
 * Reached only by the portal, which holds `SANDBOX_PORTAL_SECRET`. Two more headers travel with a
 * person's requests: their session token, and Access's assertion, which the portal forwards and this
 * side validates. A session is honoured only with an assertion for the same address
 * (`SandboxAccessGuard`). Hidden from the public OpenAPI document, like the hosted verifier: this is
 * the portal's back end, not a customer API — a participant's automation uses an organisation API key
 * on the platform's ordinary routes.
 *
 * The organisation in a path is never trusted: it is checked against the signed-in person's
 * memberships, and another organisation's id is answered as not found (CLAUDE.md §9).
 */
@ApiExcludeController()
@Public()
@Controller("sandbox/v1")
export class SandboxController {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: PlatformConfig,
    @Inject(SANDBOX_SERVICE) private readonly sandbox: SandboxService | undefined,
  ) {}

  private service(secret: string | undefined): SandboxService {
    const expected = this.config.SANDBOX_PORTAL_SECRET;
    // Off, and wrong secret, both look like nothing is here.
    if (!this.sandbox || !expected) throw PlatformError.notFound("Route");
    if (!secret || !constantTimeEquals(secret, expected)) throw PlatformError.unauthenticated();
    return this.sandbox;
  }

  private async signedIn(
    secret: string | undefined,
    session: string | undefined,
  ): Promise<{ service: SandboxService; context: SignedInContext }> {
    const service = this.service(secret);
    if (!session) throw PlatformError.unauthenticated();
    return { service, context: await service.authenticate(session) };
  }

  // --- entering by the Access identity (ADR 0018) ------------------------------------------------

  @Post("access/enter")
  @HttpCode(200)
  async enter(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_ACCESS_ASSERTION_HEADER) assertion: string | undefined,
  ) {
    const service = this.service(secret);
    return service.enter(await service.identify(assertion));
  }

  @Post("access/profile")
  @HttpCode(201)
  async profile(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_ACCESS_ASSERTION_HEADER) assertion: string | undefined,
    @Body() body: unknown,
  ) {
    const service = this.service(secret);
    const identity = await service.identify(assertion);
    const input = profileSchema.parse(body ?? {});
    return service.createProfile(identity, {
      displayName: input.displayName,
      ...(input.organisation ? { organisation: input.organisation } : {}),
      ...(input.invitationToken ? { invitationToken: input.invitationToken } : {}),
    });
  }

  /** The token is a bearer secret: it travels in a body, never in a path a log could keep. */
  @Post("invitations/lookup")
  @HttpCode(200)
  async invitation(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_ACCESS_ASSERTION_HEADER) assertion: string | undefined,
    @Body() body: unknown,
  ) {
    const service = this.service(secret);
    const identity = await service.identify(assertion);
    return service.invitation(acceptSchema.parse(body ?? {}).invitationToken, identity);
  }

  @Post("invitations/accept")
  @HttpCode(204)
  async accept(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Body() body: unknown,
  ) {
    const { service, context } = await this.signedIn(secret, session);
    await service.acceptInvitation(context, acceptSchema.parse(body ?? {}).invitationToken);
  }

  // --- presenting a PID, optionally ---------------------------------------------------------------

  @Post("pid-presentations")
  @HttpCode(201)
  async startPid(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Body() body: unknown,
  ) {
    const { service, context } = await this.signedIn(secret, session);
    return service.startPidPresentation(context, {
      interactionType: startSchema.parse(body ?? {}).interactionType,
      correlationId: newCorrelationId(),
    });
  }

  @Post("pid-presentations/:attemptId/complete")
  @HttpCode(200)
  async completePid(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("attemptId") attemptId: string,
    @Body() body: unknown,
  ) {
    assertUuidPathParam("attemptId", attemptId);
    const { service, context } = await this.signedIn(secret, session);
    const { bindingToken } = bindingSchema.parse(body ?? {});
    return service.completePidPresentation(
      context,
      attemptId,
      bindingToken,
      newCorrelationId(),
    );
  }

  @Post("sign-out")
  @HttpCode(204)
  async signOut(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
  ) {
    const service = this.service(secret);
    if (session) await service.signOut(session);
  }

  // --- the signed-in person --------------------------------------------------------------------

  @Get("me")
  async me(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
  ) {
    const { context } = await this.signedIn(secret, session);
    return {
      person: {
        id: context.person.id,
        displayName: context.person.displayName,
        email: context.person.email,
        pidPresented: Boolean(context.person.subject),
      },
      memberships: context.memberships.map((m) => ({
        organisationId: m.tenantId,
        role: m.role,
      })),
    };
  }

  @Post("organisations")
  @HttpCode(201)
  async addOrganisation(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Body() body: unknown,
  ) {
    const { service, context } = await this.signedIn(secret, session);
    return service.addOrganisation(context, organisationSchema.parse(body ?? {}));
  }

  @Get("organisations/:organisationId")
  async organisation(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") organisationId: string,
  ) {
    assertUuidPathParam("organisationId", organisationId);
    const { service, context } = await this.signedIn(secret, session);
    return service.organisation(context, organisationId);
  }

  @Get("organisations/:organisationId/members")
  async members(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") organisationId: string,
  ) {
    assertUuidPathParam("organisationId", organisationId);
    const { service, context } = await this.signedIn(secret, session);
    const members = await service.members(context, organisationId);
    // Members of one organisation see each other's addresses (ADR 0018 Decision 5); the route is
    // reached only through a membership of that organisation.
    return members.map((m) => ({
      personId: m.personId,
      displayName: m.displayName,
      email: m.email,
      role: m.role,
    }));
  }

  @Delete("organisations/:organisationId/members/:personId")
  @HttpCode(204)
  async removeMember(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") organisationId: string,
    @Param("personId") personId: string,
  ) {
    assertUuidPathParam("organisationId", organisationId);
    assertUuidPathParam("personId", personId);
    const { service, context } = await this.signedIn(secret, session);
    await service.removeMember(context, organisationId, personId);
  }

  @Post("organisations/:organisationId/invitations")
  @HttpCode(201)
  async invite(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") organisationId: string,
    @Body() body: unknown,
  ) {
    assertUuidPathParam("organisationId", organisationId);
    const { service, context } = await this.signedIn(secret, session);
    const input = invitationSchema.parse(body ?? {});
    return service.invite(context, organisationId, input.role, input.email);
  }

  @Get("organisations/:organisationId/api-keys")
  async apiKeys(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") organisationId: string,
  ) {
    assertUuidPathParam("organisationId", organisationId);
    const { service, context } = await this.signedIn(secret, session);
    return service.listApiKeys(context, organisationId);
  }

  @Post("organisations/:organisationId/api-keys")
  @HttpCode(201)
  async createApiKey(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") organisationId: string,
    @Body() body: unknown,
  ) {
    assertUuidPathParam("organisationId", organisationId);
    const { service, context } = await this.signedIn(secret, session);
    return service.createApiKey(context, organisationId, apiKeySchema.parse(body ?? {}).label);
  }

  @Delete("organisations/:organisationId/api-keys/:keyId")
  @HttpCode(204)
  async revokeApiKey(
    @Headers(SANDBOX_PORTAL_SECRET_HEADER) secret: string | undefined,
    @Headers(SANDBOX_SESSION_HEADER) session: string | undefined,
    @Param("organisationId") organisationId: string,
    @Param("keyId") keyId: string,
  ) {
    assertUuidPathParam("organisationId", organisationId);
    assertUuidPathParam("keyId", keyId);
    const { service, context } = await this.signedIn(secret, session);
    await service.revokeApiKey(context, organisationId, keyId);
  }
}
