import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway self-signed certificate for a key the caller already generated.
 *
 * Exists because `openssl req -key /dev/stdin` does not work everywhere: on WSL2 it fails with
 * `BIO_new_file: no such file`, so three adapter tests failed at setup on a machine where the engine
 * was perfectly reachable — a failure that looks like a broken contract test and is a broken
 * `/dev/stdin`. The key is written to a file under the process's own temporary directory, used, and
 * removed in a `finally`, so it does not survive a failure either.
 *
 * Development material only: two days' validity, and a subject that says so.
 */
export const selfSignedCertificate = (privateKeyPem: string, commonName: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "edtp-test-key-"));
  const keyPath = join(dir, "key.pem");
  try {
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
    return execFileSync("openssl", [
      "req",
      "-new",
      "-x509",
      "-key",
      keyPath,
      "-days",
      "2",
      "-subj",
      `/CN=${commonName}/O=Development only/C=EU`,
    ]).toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
