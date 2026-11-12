import type { EngineTenantPort, EudiVerifierProvisioningPort } from "@edtp/eudi-verifier-port";
import type { EngineCredentialRepository } from "@edtp/persistence";
import { type Clock, newOpaqueToken, PlatformError } from "@edtp/shared";
import type { Logger } from "../../logging/logger.js";

/**
 * Engine tenants created at runtime (sandbox G-6, specification §8.3).
 *
 * Creates the tenant with every role (A16), keeps its client sealed in the database, and asserts the
 * minimal session retention CLAUDE.md §5 requires of every Relying Party Instance before anything
 * uses it — so a tenant that cannot be made minimal is never handed out.
 */
export class EngineTenantService {
  constructor(
    private readonly engine: EngineTenantPort,
    private readonly credentials: EngineCredentialRepository,
    private readonly provisioning: EudiVerifierProvisioningPort,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly sessionTtlSeconds: number,
  ) {}

  /** A fresh reference: a prefix naming the purpose and 12 random characters. */
  static newRef(prefix: "sbx-rp" | "sbx-iss" | "sbx-op"): string {
    return `${prefix}-${newOpaqueToken(9)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "0")}`;
  }

  async create(engineTenantRef: string, name: string): Promise<string> {
    if (await this.credentials.find(engineTenantRef)) {
      throw PlatformError.conflict(
        "engine_tenant_exists",
        "That engine tenant already exists.",
      );
    }
    const client = await this.engine.createEngineTenant({ engineTenantRef, name });
    await this.credentials.save({ engineTenantRef, ...client, createdAt: this.clock.now() });
    await this.provisioning.applyRetentionSettings(engineTenantRef, {
      sessionTtlSeconds: this.sessionTtlSeconds,
      cleanupMode: "ANONYMIZE",
    });
    this.logger.info("engine tenant created", { engineTenantRef });
    return engineTenantRef;
  }
}
