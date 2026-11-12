import type { EngineTenantPort } from "@edtp/eudi-verifier-port";
import { PlatformError } from "@edtp/shared";
import { z } from "zod";
import type { EngineClient } from "./client.js";

/**
 * The engine reference under which the client resolves the engine's **root** client. Root can only
 * manage tenants (`roles: ["tenants:manage"]`, `tenant_id: null`, `docs/interop-findings.md` A9), so
 * this adapter uses it for one call and nothing else.
 */
export const ENGINE_ROOT_REF = "__engine_root__";

/**
 * Every role an engine tenant of the platform may need, granted at creation because a tenant's roles
 * cannot be widened later (A16) — the same set `scripts/create-engine-tenant.sh` grants.
 */
export const ENGINE_TENANT_ROLES = [
  "presentation:manage",
  "presentation:request",
  "issuance:manage",
  "issuance:offer",
  "clients:manage",
  "registrar:manage",
  "tenant:admin",
] as const;

const REF = /^[a-z0-9-]{3,63}$/;

const createdTenantSchema = z.object({
  client: z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) }),
});

/** `POST /api/tenant` with the root client: a tenant and its first admin client. */
export class EudiploTenantAdapter implements EngineTenantPort {
  constructor(private readonly client: EngineClient) {}

  async createEngineTenant(input: { readonly engineTenantRef: string; readonly name: string }) {
    if (!REF.test(input.engineTenantRef) || input.engineTenantRef === ENGINE_ROOT_REF) {
      throw PlatformError.validation(
        "invalid_engine_tenant_ref",
        "An engine tenant reference is 3 to 63 lowercase letters, digits and dashes.",
      );
    }
    const response = await this.client.request(ENGINE_ROOT_REF, "POST", "/tenant", {
      id: input.engineTenantRef,
      name: input.name,
      roles: ENGINE_TENANT_ROLES,
    });
    const parsed = createdTenantSchema.safeParse(response);
    if (!parsed.success) {
      // Never echo the response: it may carry the secret.
      throw PlatformError.engine(
        "engine_tenant_no_client",
        "The engine created no client for the tenant.",
      );
    }
    return parsed.data.client;
  }
}
