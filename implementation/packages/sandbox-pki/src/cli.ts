#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileKeyStore } from "./keystore.js";
import { createTrustDomain } from "./trust-domain.js";
import { toPem } from "./x509.js";

/**
 * Create the sandbox's trust domain once (ADR 0014):
 *
 *   SANDBOX_KEYSTORE_KEY=<base64, 32 bytes> node packages/sandbox-pki/dist/cli.js init [--dir <dir>]
 *
 * Keys go to `<dir>/keys` sealed; certificates to `<dir>/certs` as PEM. The directory defaults to
 * `~/.edtp/sandbox-pki`, outside the repository: no key, sealed or not, is ever committed.
 */
async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command !== "init") {
    process.stderr.write("usage: cli.js init [--dir <dir>]\n");
    process.exitCode = 2;
    return;
  }
  const dirFlag = rest.indexOf("--dir");
  const dir =
    dirFlag >= 0 && rest[dirFlag + 1]
      ? (rest[dirFlag + 1] as string)
      : join(homedir(), ".edtp", "sandbox-pki");
  const sealing = Buffer.from(process.env.SANDBOX_KEYSTORE_KEY ?? "", "base64");
  if (sealing.length !== 32) {
    process.stderr.write("SANDBOX_KEYSTORE_KEY must be set to 32 bytes, base64.\n");
    process.exitCode = 2;
    return;
  }
  const issued = await createTrustDomain(
    new FileKeyStore(join(dir, "keys"), sealing),
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

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
