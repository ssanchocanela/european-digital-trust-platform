#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileKeyStore } from "./keystore.js";
import { createTrustDomain, nameOf, TRUST_DOMAIN } from "./trust-domain.js";
import { issueWrpac } from "./wrpac.js";
import { readCertificationRequest, toPem } from "./x509.js";

/**
 * The sandbox trust domain's operator tool (ADR 0014). Two commands:
 *
 *   SANDBOX_KEYSTORE_KEY=<base64, 32 bytes> node packages/sandbox-pki/dist/cli.js init [--dir <dir>]
 *
 * creates the domain once: keys to `<dir>/keys`, sealed; certificates to `<dir>/certs` as PEM.
 *
 *   SANDBOX_KEYSTORE_KEY=… node packages/sandbox-pki/dist/cli.js issue-access [--dir <dir>] \
 *     --csr req.pem --dns <host> --public-base https://<host>/sandbox/public \
 *     --legal-name "<name>" --trade-name "<name>" --country EU --identifier SB:EU-000000 \
 *     --service <id> --support https://… --out cert.pem
 *
 * issues one correct access certificate (AC-00) from the sandbox Access CA against a request — for
 * the sandbox operator's own sign-in verifier, which a sandbox wallet build trusts only under the
 * sandbox's anchors (S4). Participants get theirs from the portal, never from this.
 *
 * The directory defaults to `~/.edtp/sandbox-pki`, outside the repository: no key, sealed or not, is
 * ever committed.
 */
const flag = (args: string[], name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function sealing(): Buffer {
  const key = Buffer.from(process.env.SANDBOX_KEYSTORE_KEY ?? "", "base64");
  if (key.length !== 32)
    throw new Error("SANDBOX_KEYSTORE_KEY must be set to 32 bytes, base64.");
  return key;
}

async function init(dir: string): Promise<void> {
  const issued = await createTrustDomain(
    new FileKeyStore(join(dir, "keys"), sealing()),
    new Date(),
  );
  await mkdir(join(dir, "certs"), { recursive: true });
  for (const { member, certificate } of issued) {
    await writeFile(
      join(dir, "certs", `${member.name}.pem`),
      toPem(certificate, "CERTIFICATE"),
    );
    process.stdout.write(`${member.name}\t${member.listedOn ?? "-"}\t${member.commonName}\n`);
  }
  process.stdout.write(
    `\nKeys sealed in ${join(dir, "keys")}; certificates in ${join(dir, "certs")}.\n`,
  );
}

async function issueAccess(dir: string, args: string[]): Promise<void> {
  const need = (name: string) => {
    const value = flag(args, name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const pem = await readFile(need("csr"), "utf8");
  const der = Buffer.from(
    pem.replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----/g, "").replace(/\s+/g, ""),
    "base64",
  );
  const publicKey = readCertificationRequest(der);
  const base = need("public-base").replace(/\/+$/, "");
  const ca = TRUST_DOMAIN.find((m) => m.name === "access-ca");
  if (!ca) throw new Error("no access-ca in the trust domain");
  const { der: cert } = issueWrpac({
    variant: "AC-00",
    subject: {
      legalName: need("legal-name"),
      tradeName: need("trade-name"),
      country: need("country"),
      localIdentifier: need("identifier"),
      serviceIdentifier: need("service"),
      supportUri: need("support"),
      dnsNames: [need("dns")],
    },
    subjectPublicKey: publicKey,
    issuer: {
      name: nameOf(ca.commonName),
      signer: await new FileKeyStore(join(dir, "keys"), sealing()).signer("access-ca"),
    },
    urls: {
      cps: `${base}/cps`,
      crl: `${base}/crl/access-ca.crl`,
      caIssuers: `${base}/ca/access-ca.cer`,
      register: `${base}/wrp`,
    },
    now: new Date(),
  });
  const caPem = await readFile(join(dir, "certs", "access-ca.pem"), "utf8");
  await writeFile(need("out"), toPem(cert, "CERTIFICATE") + caPem);
  process.stdout.write(
    `Wrote the certificate and the Access CA, leaf first, to ${need("out")}.\n`,
  );
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const dir = flag(rest, "dir") ?? join(homedir(), ".edtp", "sandbox-pki");
  if (command === "init") return init(dir);
  if (command === "issue-access") return issueAccess(dir, rest);
  process.stderr.write(
    "usage: cli.js init [--dir <dir>] | cli.js issue-access [--dir <dir>] --csr … (see the source header)\n",
  );
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
