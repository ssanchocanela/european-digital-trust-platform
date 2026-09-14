import type { ApiKeyRepository } from "@edtp/persistence";
import {
  type CorrelationId,
  newCorrelationId,
  PlatformError,
  type TenantId,
} from "@edtp/shared";
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import type { Request } from "express";
import type { PlatformConfig } from "../config.js";
import { API_KEY_REPOSITORY, CONFIG_TOKEN } from "../tokens.js";

/**
 * Authentication and tenant resolution.
 *
 * One API key per tenant, presented as `Authorization: Bearer <key>`. **The tenant is
 * derived from the credential, never from the request.** A `tenantId` in a path is
 * checked against the resolved tenant and rejected on mismatch — see
 * `docs/knowledge-alignment.md` KA-4.
 *
 * This is a documented development mechanism, listed in `docs/security-limitations.md`.
 */
export interface RequestContext {
  readonly tenantId: TenantId;
  readonly correlationId: CorrelationId;
  readonly isAdmin: boolean;
}

/**
 * The request with its resolved context attached.
 *
 * A local intersection type rather than a global module augmentation: augmenting Express's
 * types couples this file to a particular `@types/express` layout, and an explicit type is
 * clearer about the fact that `edtp` exists only after the guard has run.
 */
export type ContextualRequest = Request & { edtp?: RequestContext };

/** Marks a route reachable with the bootstrap administrative key instead of a tenant key. */
export const ADMIN_ONLY = "edtp:adminOnly";
export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true);

/** Marks a route reachable without authentication, e.g. health. */
export const PUBLIC_ROUTE = "edtp:public";
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(API_KEY_REPOSITORY) private readonly apiKeys: ApiKeyRepository,
    @Inject(CONFIG_TOKEN) private readonly config: PlatformConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();
    const isPublic =
      Reflect.getMetadata(PUBLIC_ROUTE, handler) ??
      Reflect.getMetadata(PUBLIC_ROUTE, controller);
    const request = context.switchToHttp().getRequest<ContextualRequest>();

    // A correlation id is attached to every request, authenticated or not, so a rejected
    // request can still be traced.
    const correlationId = resolveCorrelationId(request);

    if (isPublic) {
      request.edtp = { tenantId: "" as TenantId, correlationId, isAdmin: false };
      return true;
    }

    const presented = bearerToken(request);
    if (!presented) throw PlatformError.unauthenticated();

    const adminOnly =
      Reflect.getMetadata(ADMIN_ONLY, handler) ?? Reflect.getMetadata(ADMIN_ONLY, controller);

    if (constantTimeEquals(presented, this.config.PLATFORM_ADMIN_API_KEY)) {
      if (!adminOnly) {
        // The administrative key exists to create the first tenant. Letting it act as any
        // tenant would make every tenant-scoped authorisation check meaningless.
        throw PlatformError.forbidden(
          "admin_key_not_tenant_scoped",
          "The administrative key cannot be used for tenant-scoped operations. Use the " +
            "tenant's own API key.",
        );
      }
      request.edtp = { tenantId: "" as TenantId, correlationId, isAdmin: true };
      return true;
    }

    if (adminOnly)
      throw PlatformError.forbidden("admin_required", "Administrative access required.");

    const tenantId = await this.apiKeys.resolveTenant(presented);
    if (!tenantId) throw PlatformError.unauthenticated();

    request.edtp = { tenantId, correlationId, isAdmin: false };
    return true;
  }
}

const bearerToken = (request: ContextualRequest): string | undefined => {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const [scheme, ...rest] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer") return undefined;
  const value = rest.join(" ").trim();
  return value.length > 0 ? value : undefined;
};

const CORRELATION_HEADER = "x-correlation-id";
/** Bounded and character-restricted: the value reaches logs, so it is untrusted input. */
const CORRELATION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const resolveCorrelationId = (request: ContextualRequest): CorrelationId => {
  const supplied = request.headers[CORRELATION_HEADER];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  return value && CORRELATION_PATTERN.test(value)
    ? (value as CorrelationId)
    : newCorrelationId();
};

const constantTimeEquals = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Injects the resolved request context into a handler. */
export const Ctx = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<ContextualRequest>();
  if (!request.edtp) {
    throw PlatformError.internal(
      "request_context_missing",
      "The request context was not resolved.",
    );
  }
  return request.edtp;
});

/**
 * Asserts that a `tenantId` appearing in a path matches the authenticated tenant.
 *
 * The path value is never the source of truth; it is only ever checked against the value
 * the credential resolved to. A mismatch is a 403, and the cross-tenant tests assert it.
 */
/**
 * Validates an identifier taken from a path segment.
 *
 * Every identifier the platform issues is a UUID, and a body field carrying one is parsed by a zod
 * schema with `.uuid()`. A **path** segment had no such check, so a request to
 * `GET /v1/presentations/null` reached the repository and produced a failed SQL statement — a `500`
 * for what is plainly a client error, with the whole query in the log. Found when the operator console
 * passed through a malformed id, which is exactly what a browser-facing client does.
 *
 * `CLAUDE.md` §9 says validate all input; a path segment is input.
 */
export const assertUuidPathParam = (name: string, value: string): string => {
  if (!UUID_PATTERN.test(value)) {
    throw PlatformError.validation("invalid_path_parameter", `${name} must be a UUID.`, [
      // The name of the parameter, never the value: an invalid value is attacker-supplied and is
      // echoed nowhere.
      { path: name, code: "invalid_uuid", message: "expected a UUID" },
    ]);
  }
  return value;
};

/**
 * RFC 4122 shape, any version. Deliberately not a version-specific pattern: the platform issues v4
 * today, and a check that pinned the version would reject a future v7 identifier for no reason.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const assertTenantMatches = (ctx: RequestContext, pathTenantId: string): TenantId => {
  if (ctx.tenantId !== pathTenantId) {
    throw PlatformError.forbidden(
      "tenant_mismatch",
      "The tenant in the path does not match the authenticated tenant.",
    );
  }
  return ctx.tenantId;
};
