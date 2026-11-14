import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import type { PlatformConfig } from "../config.js";
import { SANDBOX_ACCESS_ASSERTION_HEADER } from "../modules/sandbox/access-identity.js";
import type { SandboxService } from "../modules/sandbox/sandbox.service.js";
import { CONFIG_TOKEN, SANDBOX_SERVICE } from "../tokens.js";
import { constantTimeEquals } from "./auth.js";

const SESSION_HEADER = "x-edtp-sandbox-session";
const SECRET_HEADER = "x-edtp-sandbox-portal-secret";

/**
 * ADR 0018 Decision 2, in one place for every sandbox portal route: a session is honoured only with
 * a valid Access assertion for the same address. Otherwise the session is ended and the request is
 * unauthenticated — so removing someone from the Access policy, or Access's own session lapsing,
 * locks them out at the next request.
 *
 * A guard rather than a check in each controller, so a route added later cannot forget it. It acts
 * only on `/sandbox/v1/` requests that carry a session and the portal's secret; everything else is
 * left to the controllers, which refuse it as before.
 */
@Injectable()
export class SandboxAccessGuard implements CanActivate {
  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: PlatformConfig,
    @Inject(SANDBOX_SERVICE) private readonly sandbox: SandboxService | undefined,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.sandbox || !this.config.SANDBOX_PORTAL_SECRET) return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.path.startsWith("/sandbox/v1/")) return true;
    const session = request.header(SESSION_HEADER);
    const secret = request.header(SECRET_HEADER);
    // No session: nothing to bind. Wrong secret: the controller answers it, and an outsider never
    // gets to end someone's session by guessing.
    if (!session || !secret || !constantTimeEquals(secret, this.config.SANDBOX_PORTAL_SECRET)) {
      return true;
    }
    await this.sandbox.checkSession(session, request.header(SANDBOX_ACCESS_ASSERTION_HEADER));
    return true;
  }
}
