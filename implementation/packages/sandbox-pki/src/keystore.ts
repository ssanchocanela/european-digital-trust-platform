import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Signer } from "./x509.js";

/**
 * Where the sandbox's CA and signer keys live (specification §8.2).
 *
 * A port, so the keys can move to an HSM without touching anything that signs. Nothing outside this
 * package holds a sandbox private key: callers get a `Signer`, which signs and publishes a public
 * key, and never the key itself.
 */
export interface SandboxKeyStore {
  /** Generate a new P-256 key under `name`. Refuses to replace an existing one. */
  create(name: string): Promise<Signer>;
  signer(name: string): Promise<Signer>;
  has(name: string): Promise<boolean>;
}

const NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error(`invalid key name: ${name}`);
}

function signerFor(privateKey: KeyObject): Signer {
  return {
    publicKey: createPublicKey(privateKey),
    sign: (data) => sign("sha256", data, { key: privateKey, dsaEncoding: "der" }),
  };
}

/**
 * Keys as files, each a PKCS#8 DER sealed with AES-256-GCM under a key from the environment, the key
 * name bound in as associated data so a file renamed onto another name does not open. Written with
 * mode 0600 and never overwritten.
 *
 * **A development store.** On the sandbox VM there is no HSM, so this is the CA key protection the
 * sandbox has; it is listed in `docs/security-limitations.md`. A leaked key compromises the sandbox
 * domain only, which only sandbox wallet builds trust (ADR 0014).
 */
export class FileKeyStore implements SandboxKeyStore {
  constructor(
    private readonly directory: string,
    private readonly sealingKey: Buffer,
  ) {
    if (sealingKey.length !== 32)
      throw new Error("the key store's sealing key must be 32 bytes");
  }

  private path(name: string): string {
    assertName(name);
    return join(this.directory, `${name}.key`);
  }

  async has(name: string): Promise<boolean> {
    try {
      await access(this.path(name), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async create(name: string): Promise<Signer> {
    if (await this.has(name))
      throw new Error(`key ${name} already exists; keys are never replaced`);
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.sealingKey, nonce);
    cipher.setAAD(Buffer.from(name, "utf8"));
    const body = Buffer.concat([cipher.update(pkcs8), cipher.final()]);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.path(name), Buffer.concat([nonce, body, cipher.getAuthTag()]), {
      mode: 0o600,
      flag: "wx",
    });
    return signerFor(privateKey);
  }

  async signer(name: string): Promise<Signer> {
    const raw = await readFile(this.path(name));
    const decipher = createDecipheriv("aes-256-gcm", this.sealingKey, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const pkcs8 = Buffer.concat([
      decipher.update(raw.subarray(12, raw.length - 16)),
      decipher.final(),
    ]);
    return signerFor(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }));
  }
}
