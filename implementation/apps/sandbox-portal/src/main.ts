import { z } from "zod";
import { httpApi } from "./api.js";
import { createApp } from "./app.js";

/**
 * The sandbox portal process. It holds one secret, the portal secret, and reaches the platform's
 * `/sandbox/v1` routes with it; nothing else of the platform is reachable from here.
 */
const schema = z.object({
  SANDBOX_PORTAL_PORT: z.coerce.number().int().min(1).max(65_535).default(3300),
  SANDBOX_PORTAL_BIND_HOST: z.string().min(1).default("127.0.0.1"),
  /** The address participants see; the wallet returns here and forms must come from it. */
  SANDBOX_PORTAL_PUBLIC_URL: z.string().url(),
  SANDBOX_PLATFORM_URL: z.string().url(),
  SANDBOX_PORTAL_SECRET: z.string().min(32),
  /** `true` on the sandbox VM: every request must carry Cloudflare Access's identity (ADR 0017). */
  SANDBOX_PORTAL_REQUIRE_ACCESS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** The directory holding the wallet build and its wallet.json; unset, nothing is offered. */
  SANDBOX_PORTAL_WALLET_DIR: z.string().min(1).optional(),
});

function main(): void {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write(
      `Invalid environment configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}\n`,
    );
    process.exit(1);
  }
  const config = parsed.data;
  const app = createApp({
    publicUrl: config.SANDBOX_PORTAL_PUBLIC_URL,
    api: httpApi(config.SANDBOX_PLATFORM_URL, config.SANDBOX_PORTAL_SECRET),
    requireAccess: config.SANDBOX_PORTAL_REQUIRE_ACCESS,
    ...(config.SANDBOX_PORTAL_WALLET_DIR
      ? { walletDir: config.SANDBOX_PORTAL_WALLET_DIR }
      : {}),
  });
  const server = app.listen(config.SANDBOX_PORTAL_PORT, config.SANDBOX_PORTAL_BIND_HOST, () => {
    process.stdout.write(
      `${JSON.stringify({
        time: new Date().toISOString(),
        level: "info",
        service: "sandbox-portal",
        message: "listening",
        port: config.SANDBOX_PORTAL_PORT,
        host: config.SANDBOX_PORTAL_BIND_HOST,
      })}\n`,
    );
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
