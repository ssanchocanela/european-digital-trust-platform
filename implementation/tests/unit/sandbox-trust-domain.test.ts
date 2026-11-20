import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTrustDomain,
  extendTrustDomain,
  FileKeyStore,
  SANDBOX_POLICY_OID,
  TRUST_DOMAIN,
  toPem,
} from "@edtp/sandbox-pki";
import { describe, expect, it } from "vitest";

/** The sandbox trust domain and its key store (ADR 0014 Decision 2, specification §8.2). */
const sealing = Buffer.alloc(32, 5);
const now = new Date("2026-11-12T10:00:00Z");

describe("FileKeyStore", () => {
  it("seals keys at rest, with mode 0600, and signs after reopening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-ks-"));
    const store = new FileKeyStore(dir, sealing);
    const created = await store.create("access-ca");
    const file = readFileSync(join(dir, "access-ca.key"));
    expect(file.includes(Buffer.from("BEGIN"))).toBe(false);
    expect(statSync(join(dir, "access-ca.key")).mode & 0o777).toBe(0o600);
    const reopened = await new FileKeyStore(dir, sealing).signer("access-ca");
    expect(reopened.publicKey.export({ format: "jwk" })).toEqual(
      created.publicKey.export({ format: "jwk" }),
    );
  });

  it("never replaces a key, refuses a bad name, and does not open under another key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-ks-"));
    const store = new FileKeyStore(dir, sealing);
    await store.create("pid-ca");
    await expect(store.create("pid-ca")).rejects.toThrow(/never replaced/);
    await expect(store.create("../escape")).rejects.toThrow(/invalid key name/);
    await expect(new FileKeyStore(dir, Buffer.alloc(32, 6)).signer("pid-ca")).rejects.toThrow();
  });

  it("does not open a key file renamed onto another key's name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-ks-"));
    const store = new FileKeyStore(dir, sealing);
    await store.create("registrar");
    renameSync(join(dir, "registrar.key"), join(dir, "access-ca.key"));
    await expect(store.signer("access-ca")).rejects.toThrow();
  });
});

describe("createTrustDomain", () => {
  it("creates every member once: roots as CAs, signing leaves chained, all with the sandbox policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-td-"));
    const store = new FileKeyStore(dir, sealing);
    const issued = await createTrustDomain(store, now);
    expect(issued.map((i) => i.member.name)).toEqual(TRUST_DOMAIN.map((m) => m.name));

    const byName = new Map(
      issued.map((i) => [i.member.name, new X509Certificate(i.certificate)]),
    );
    for (const ca of [
      "access-ca",
      "registrar",
      "pid-ca",
      "access-ca-untrusted",
      "registrar-untrusted",
      "pid-ca-untrusted",
      "eaa-ca",
      "eaa-ca-untrusted",
    ]) {
      expect(byName.get(ca)?.ca, ca).toBe(true);
      expect(byName.get(ca)?.subject).toContain("TEST ONLY");
    }
    expect(byName.get("lote-signer")?.ca).toBe(false);
    const signing = byName.get("registrar-signing");
    expect(signing?.checkIssued(byName.get("registrar") as X509Certificate)).toBe(true);
    expect(signing?.checkIssued(byName.get("registrar-untrusted") as X509Certificate)).toBe(
      false,
    );

    // Every member has its own key: no two share a public key.
    const keys = new Set(
      issued.map(
        (i) => new X509Certificate(i.certificate).publicKey.export({ format: "jwk" }).x,
      ),
    );
    expect(keys.size).toBe(TRUST_DOMAIN.length);

    // openssl agrees the signing leaf chains to its root, and sees the policy.
    const files = mkdtempSync(join(tmpdir(), "sbx-td-pem-"));
    for (const i of issued)
      writeFileSync(join(files, `${i.member.name}.pem`), toPem(i.certificate, "CERTIFICATE"));
    const verify = execFileSync(
      "openssl",
      [
        "verify",
        "-attime",
        String(now.getTime() / 1000 + 60),
        "-CAfile",
        "registrar.pem",
        "registrar-signing.pem",
      ],
      { cwd: files, encoding: "utf8" },
    );
    expect(verify).toContain("OK");
    const text = execFileSync("openssl", ["x509", "-in", "access-ca.pem", "-noout", "-text"], {
      cwd: files,
      encoding: "utf8",
    });
    expect(text).toContain(`Policy: ${SANDBOX_POLICY_OID}`);
  });

  it("lists only the four trusted CAs, one per domain, and never an untrusted one", () => {
    const listed = TRUST_DOMAIN.filter((m) => m.listedOn).map((m) => [m.name, m.listedOn]);
    expect(listed).toEqual([
      ["access-ca", "WRPAC"],
      ["registrar", "WRPRC"],
      ["pid-ca", "PID"],
      ["eaa-ca", "EAA"],
    ]);
  });

  it("refuses to regenerate an existing domain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-td-"));
    const store = new FileKeyStore(dir, sealing);
    await createTrustDomain(store, now);
    await expect(createTrustDomain(store, now)).rejects.toThrow(/refusing to regenerate/);
  });
});

describe("extendTrustDomain (ADR 0023)", () => {
  /** A domain as created before ADR 0023: every member without `addedBy`. */
  async function olderDomain() {
    const dir = mkdtempSync(join(tmpdir(), "sbx-td-"));
    const store = new FileKeyStore(dir, sealing);
    const certs = new Set<string>();
    const issued = await createTrustDomain(store, now);
    for (const i of issued) {
      if (i.member.addedBy) {
        // Undo what a pre-ADR-0023 init would not have created.
        rmSync(join(dir, `${i.member.name}.key`));
      } else certs.add(i.member.name);
    }
    return { store, certs };
  }

  it("adds only the members added later, and is then a no-op", async () => {
    const { store, certs } = await olderDomain();
    const has = async (n: string) => certs.has(n);
    const added = await extendTrustDomain(store, has, now);
    expect(added.map((a) => a.member.name)).toEqual(["eaa-ca", "eaa-ca-untrusted"]);
    for (const a of added) {
      certs.add(a.member.name);
      const x = new X509Certificate(a.certificate);
      expect(x.ca).toBe(true);
      expect(x.subject).toContain("TEST ONLY");
    }
    expect(await extendTrustDomain(store, has, now)).toEqual([]);
  });

  it("refuses a key without a certificate, and a missing original member", async () => {
    const { store, certs } = await olderDomain();
    await store.create("eaa-ca");
    await expect(extendTrustDomain(store, async (n) => certs.has(n), now)).rejects.toThrow(
      /key without a certificate/,
    );
    const { store: other, certs: otherCerts } = await olderDomain();
    otherCerts.delete("pid-ca");
    await expect(extendTrustDomain(other, async (n) => otherCerts.has(n), now)).rejects.toThrow(
      /pid-ca has a key without a certificate/,
    );
  });
});
