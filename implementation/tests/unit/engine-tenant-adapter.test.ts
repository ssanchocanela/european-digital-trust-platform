import {
  ENGINE_ROOT_REF,
  ENGINE_TENANT_ROLES,
  EngineClient,
  EudiploTenantAdapter,
} from "@edtp/eudiplo-adapter";
import { FixedClock, PlatformError } from "@edtp/shared";
import { describe, expect, it } from "vitest";

/**
 * Runtime engine tenant creation (sandbox G-6) against a scripted engine. The live contract — that
 * `POST /api/tenant` answers this way — is the one `scripts/create-engine-tenant.sh` has relied on
 * since September; this test pins what the adapter sends and how it treats the answer.
 */
interface Call {
  readonly url: string;
  readonly body: Record<string, unknown> | undefined;
  readonly authorization: string | undefined;
}

function engine(tenantAnswer: unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.authorization,
    });
    if (url.endsWith("/api/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "root-token", expires_in: 300 }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify(tenantAnswer), { status: 201 });
  }) as typeof fetch;
  const resolved: string[] = [];
  const client = new EngineClient({
    baseUrl: "http://engine.test",
    clock: new FixedClock(new Date("2026-11-12T00:00:00Z")),
    credentials: {
      resolve: async (ref) => {
        resolved.push(ref);
        return { engineTenantRef: ref, clientId: "root", clientSecret: "root-secret" };
      },
    },
    fetchImpl,
  });
  return { adapter: new EudiploTenantAdapter(client), calls, resolved };
}

describe("EudiploTenantAdapter", () => {
  it("creates the tenant with the root client and every role, and returns its client", async () => {
    const { adapter, calls, resolved } = engine({
      client: { clientId: "c-1", clientSecret: "s-1" },
    });
    const client = await adapter.createEngineTenant({
      engineTenantRef: "sbx-rp-abc123",
      name: "Banco Ejemplo",
    });
    expect(client).toEqual({ clientId: "c-1", clientSecret: "s-1" });
    expect(resolved).toEqual([ENGINE_ROOT_REF]);
    const create = calls.find((c) => c.url.endsWith("/api/tenant"));
    expect(create?.authorization).toBe("Bearer root-token");
    expect(create?.body).toEqual({
      id: "sbx-rp-abc123",
      name: "Banco Ejemplo",
      roles: [...ENGINE_TENANT_ROLES],
    });
  });

  it("refuses a malformed reference, and the root reference itself, before calling the engine", async () => {
    const { adapter, calls } = engine({});
    for (const ref of ["UPPER", "a", "has space", ENGINE_ROOT_REF]) {
      await expect(
        adapter.createEngineTenant({ engineTenantRef: ref, name: "x" }),
      ).rejects.toBeInstanceOf(PlatformError);
    }
    expect(calls).toHaveLength(0);
  });

  it("fails without echoing the engine's answer when no client comes back", async () => {
    const { adapter } = engine({ client: { clientId: "c-1" }, clientSecret: "leaked-secret" });
    const error = await adapter
      .createEngineTenant({ engineTenantRef: "sbx-rp-abc123", name: "x" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    expect(JSON.stringify(error)).not.toContain("leaked-secret");
    expect(String((error as Error).message)).not.toContain("leaked-secret");
  });
});
