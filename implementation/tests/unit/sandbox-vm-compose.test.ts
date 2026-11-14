import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The sandbox VM's compose file repeats the root one's engine block (ADR 0017). These checks keep the
 * two from drifting where it matters — the pinned engine, and the retention and logging settings
 * ADR 0004 makes mandatory — and keep the VM's exposure as the ADR decides it. Read as text: the
 * workspace has no YAML parser, and adding one for this is not worth a dependency.
 */
const root = readFileSync("docker-compose.yml", "utf8");
const sandbox = readFileSync("infra/sandbox-vm/docker-compose.sandbox.yml", "utf8");
const tunnel = readFileSync("infra/sandbox-vm/files/cloudflared-config.yml", "utf8");

/** The text of one service, from `  <name>:` to the next top-level service or section. */
function service(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`no service ${name}`);
  const end = lines.findIndex(
    (l, i) => i > start && /^( {2}[a-z][a-z0-9-]*:|[a-z][a-z-]*:)\s*$/.test(l),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** `KEY: value` lines of a service's environment, comments and quotes dropped. */
function environment(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = /^\s{6}([A-Z][A-Z0-9_]*): (.*)$/.exec(line);
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const imageOf = (block: string) => /^\s{4}image: (\S+)$/m.exec(block)?.[1];

describe("the sandbox VM's compose file", () => {
  it("runs the engine and the databases at the root compose file's pinned digests", () => {
    for (const name of ["eudiplo", "platform-db", "engine-db"]) {
      expect(imageOf(service(sandbox, name))).toBe(imageOf(service(root, name)));
    }
    expect(imageOf(service(sandbox, "eudiplo"))).toContain("@sha256:");
  });

  it("keeps the engine's retention, logging and outbound settings identical (ADR 0004)", () => {
    const a = environment(service(root, "eudiplo"));
    const b = environment(service(sandbox, "eudiplo"));
    for (const key of [
      "INTERNAL_URL",
      "VP_REMOVE_TA",
      "OUTBOUND_URL_ALLOW_HTTP",
      "OUTBOUND_URL_ALLOW_PRIVATE_NETWORK",
      "OUTBOUND_URL_ALLOWED_HOSTS",
      "SESSION_TTL",
      "SESSION_CLEANUP_MODE",
      "SESSION_TIDY_UP_INTERVAL",
      "LOG_SESSION_STORE",
      "LOG_ENABLE_HTTP_LOGGER",
      "LOG_ENABLE_SESSION_LOGGER",
      "AUDIT_LOG_RETENTION_DAYS",
      "AUDIT_LOG_MAX_ENTRIES_PER_TENANT",
      "OTEL_SDK_DISABLED",
    ]) {
      expect({ key, value: b[key] }).toEqual({ key, value: a[key] });
    }
    expect(b.SESSION_CLEANUP_MODE).toBe("anonymize");
    expect(b.LOG_REDACT_SENSITIVE_DATA).toBeUndefined();
  });

  it("binds every published port to loopback", () => {
    const ports = [...sandbox.matchAll(/^\s+- "([^"]+):(\d+)"$/gm)].map((m) => m[1]);
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) expect(p).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it("locks the portal behind Access, signs sandbox issuers' metadata, and runs TEST only", () => {
    expect(environment(service(sandbox, "sandbox-portal")).SANDBOX_PORTAL_REQUIRE_ACCESS).toBe(
      "true",
    );
    expect(environment(service(sandbox, "gateway")).GATEWAY_SANDBOX_SIGNED_METADATA).toBe("on");
    expect(environment(service(sandbox, "platform-api")).SANDBOX_TRUST_ENVIRONMENT).toBe(
      "TEST",
    );
  });

  it("identifies people by Cloudflare Access, and never by a development identity (ADR 0018)", () => {
    const platform = environment(service(sandbox, "platform-api"));
    expect(platform.SANDBOX_ACCESS_TEAM_DOMAIN).toMatch(/^\$\{SANDBOX_ACCESS_TEAM_DOMAIN:\?/);
    expect(platform.SANDBOX_ACCESS_AUDIENCE).toMatch(/^\$\{SANDBOX_ACCESS_AUDIENCE:\?/);
    expect(sandbox).not.toContain("SANDBOX_ACCESS_DEV_IDENTITY");
  });
});

describe("the sandbox VM's tunnel", () => {
  it("reaches the engine and the platform only through the gateway, and ends in a 404", () => {
    const services = [...tunnel.matchAll(/^\s+(?:- )?service: (\S+)$/gm)].map((m) => m[1]);
    expect(services).toEqual([
      "ssh://localhost:22",
      "http://127.0.0.1:3010",
      "http://127.0.0.1:3011",
      "http://127.0.0.1:3300",
      "http_status:404",
    ]);
  });
});
