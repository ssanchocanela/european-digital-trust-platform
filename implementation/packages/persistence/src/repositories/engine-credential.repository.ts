import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db.js";
import { engineTenantCredentials } from "../schema.js";

/**
 * Engine tenant clients created at runtime, with the secret sealed by AES-256-GCM (sandbox G-6).
 *
 * The engine tenant reference is bound into the seal as associated data, so a sealed secret copied
 * onto another row does not open: a database writer cannot swap one tenant's client for another's.
 */
export class EngineCredentialRepository {
  constructor(
    private readonly db: Database,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error("ENGINE_CREDENTIALS_KEY must be 32 bytes");
  }

  private seal(ref: string, secret: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(ref, "utf8"));
    const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64url");
  }

  private open(ref: string, sealed: string): string {
    const raw = Buffer.from(sealed, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(ref, "utf8"));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([
      decipher.update(raw.subarray(12, raw.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  }

  async save(input: {
    readonly engineTenantRef: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly createdAt: Date;
  }): Promise<void> {
    await this.db.insert(engineTenantCredentials).values({
      engineTenantRef: input.engineTenantRef,
      clientId: input.clientId,
      clientSecretSealed: this.seal(input.engineTenantRef, input.clientSecret),
      createdAt: input.createdAt,
    });
  }

  async find(
    engineTenantRef: string,
  ): Promise<{ readonly clientId: string; readonly clientSecret: string } | undefined> {
    const [row] = await this.db
      .select()
      .from(engineTenantCredentials)
      .where(eq(engineTenantCredentials.engineTenantRef, engineTenantRef));
    if (!row) return undefined;
    return {
      clientId: row.clientId,
      clientSecret: this.open(engineTenantRef, row.clientSecretSealed),
    };
  }
}
