import { X509Certificate } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FileKeyStore,
  type NameAttribute,
  nameOf,
  type SandboxKeyStore,
  type Signer,
  TRUST_DOMAIN,
} from "@edtp/sandbox-pki";

/**
 * The sandbox's trust domain as the running platform holds it (ADR 0014): the certificates of its
 * CAs and signers, read once at start, and its key store. Signers are opened per use, so no private
 * key outlives the call that needed it.
 *
 * Also the PID anchors the sign-in verifier trusts and the PID list carries — reference PID
 * Providers and "PID (demo)" (ADR 0014 Decision 5) — read from `pid-sign-in-anchors/*.pem`.
 */
export class SandboxTrustDomain {
  private constructor(
    private readonly store: SandboxKeyStore,
    private readonly certificates: ReadonlyMap<string, Buffer>,
    readonly pidSignInAnchors: readonly {
      readonly name: string;
      readonly certificate: Buffer;
    }[],
    /**
     * The Wallet Providers whose wallet attestations a hosted PID issuer accepts (S5), from
     * `wallet-provider-anchors/*.pem`: the EUDI development Wallet Providers, placed by the operator.
     */
    readonly walletProviderAnchors: readonly {
      readonly name: string;
      readonly certificate: Buffer;
    }[] = [],
  ) {}

  private static async readAnchors(
    directory: string,
  ): Promise<{ name: string; certificate: Buffer }[]> {
    const anchors: { name: string; certificate: Buffer }[] = [];
    const files = await readdir(directory).catch(() => [] as string[]);
    for (const file of files.filter((f) => f.endsWith(".pem")).sort()) {
      const x = new X509Certificate(await readFile(join(directory, file), "utf8"));
      const cn =
        x.subject
          .split("\n")
          .find((l) => l.startsWith("CN="))
          ?.slice(3) ?? file;
      anchors.push({ name: cn, certificate: x.raw });
    }
    return anchors;
  }

  static async load(directory: string, sealingKey: Buffer): Promise<SandboxTrustDomain> {
    const certificates = new Map<string, Buffer>();
    for (const member of TRUST_DOMAIN) {
      const pem = await readFile(join(directory, "certs", `${member.name}.pem`), "utf8");
      certificates.set(member.name, new X509Certificate(pem).raw);
    }
    const anchors = await SandboxTrustDomain.readAnchors(
      join(directory, "pid-sign-in-anchors"),
    );
    const walletProviders = await SandboxTrustDomain.readAnchors(
      join(directory, "wallet-provider-anchors"),
    );
    return new SandboxTrustDomain(
      new FileKeyStore(join(directory, "keys"), sealingKey),
      certificates,
      anchors,
      walletProviders,
    );
  }

  /** For tests: a domain already created in memory. */
  static from(
    store: SandboxKeyStore,
    certificates: ReadonlyMap<string, Buffer>,
    pidSignInAnchors: readonly { name: string; certificate: Buffer }[] = [],
    walletProviderAnchors: readonly { name: string; certificate: Buffer }[] = [],
  ): SandboxTrustDomain {
    return new SandboxTrustDomain(store, certificates, pidSignInAnchors, walletProviderAnchors);
  }

  certificate(name: string): Buffer {
    const der = this.certificates.get(name);
    if (!der) throw new Error(`no trust-domain member ${name}`);
    return der;
  }

  x509(name: string): X509Certificate {
    return new X509Certificate(this.certificate(name));
  }

  name(member: string): NameAttribute[] {
    const m = TRUST_DOMAIN.find((d) => d.name === member);
    if (!m) throw new Error(`no trust-domain member ${member}`);
    return nameOf(m.commonName);
  }

  signer(name: string): Promise<Signer> {
    return this.store.signer(name);
  }

  /**
   * A new key in the sandbox's sealed store, for a hosted issuer's metadata-signing access certificate
   * (S5b). Never replaced: each configuration makes a fresh one.
   */
  createKey(name: string): Promise<Signer> {
    return this.store.create(name);
  }

  /** The chain for a signing leaf, leaf first, root last: the whole chain, as a WRPRC carries it. */
  chainOf(signingKey: string): Buffer[] {
    const member = TRUST_DOMAIN.find((m) => m.name === signingKey);
    if (!member) throw new Error(`no trust-domain member ${signingKey}`);
    return member.issuer
      ? [this.certificate(member.name), this.certificate(member.issuer)]
      : [this.certificate(member.name)];
  }
}
