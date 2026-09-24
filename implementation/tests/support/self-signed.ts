import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
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
 * Development material only: two days' validity by default, and a subject that says so.
 *
 * `validity` makes the window explicit, because one test needs a certificate that has **already
 * expired** — the state the platform was blind to on 16 September 2026, and which cannot be reached
 * by waiting. `-not_before`/`-not_after` need OpenSSL 3.2 or later; the helper says so rather than
 * producing a certificate with the wrong dates if the flags are ignored.
 */
export const selfSignedCertificate = (
  privateKeyPem: string,
  commonName: string,
  validity?: { readonly notBefore: Date; readonly notAfter: Date },
): string => {
  const dir = mkdtempSync(join(tmpdir(), "edtp-test-key-"));
  const keyPath = join(dir, "key.pem");
  // `[CC]YYMMDDHHMMSSZ` — every separator gone, including the `T`, and no fractional seconds.
  const stamp = (d: Date) => `${d.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;
  try {
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
    const pem = execFileSync("openssl", [
      "req",
      "-new",
      "-x509",
      "-key",
      keyPath,
      ...(validity
        ? ["-not_before", stamp(validity.notBefore), "-not_after", stamp(validity.notAfter)]
        : ["-days", "2"]),
      "-subj",
      `/CN=${commonName}/O=Development only/C=EU`,
    ]).toString();
    if (validity) {
      // Assert rather than trust: an OpenSSL that does not know these flags would otherwise hand
      // back a certificate valid for its default window, and the test would pass for the wrong
      // reason — asserting "not expired" about a certificate that was meant to be expired.
      const actual = new X509Certificate(pem).validTo;
      const wanted = validity.notAfter.getTime();
      if (Math.abs(new Date(actual).getTime() - wanted) > 60_000) {
        throw new Error(
          `openssl ignored the requested validity: asked for ${validity.notAfter.toISOString()}, ` +
            `got ${actual}. -not_before/-not_after need OpenSSL 3.2 or later.`,
        );
      }
    }
    return pem;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
