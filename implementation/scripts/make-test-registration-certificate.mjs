#!/usr/bin/env node
/**
 * Mints a **TEST PLACEHOLDER** registration certificate.
 *
 *   node scripts/make-test-registration-certificate.mjs \
 *     --service <serviceIdentifier> --vct urn:eudi:pid:1 --claim birthdate
 *
 * ## This is not a registration certificate
 *
 * It is a self-signed JWT, issued by nobody, that has the shape the wrapped engine validates.
 * It exists so the `RPRC_19` code path can be exercised and tested before a real certificate is
 * available — `AS-AP-44-005` (`RPRC_22a`) and `EW-DM-44-023` (`RPRC_19`) are satisfied only by a
 * certificate from an authorised Provider of registration certificates, and V0 has none
 * (blocker B3).
 *
 * Every field says so. `iss` is `urn:edtp:TEST-PLACEHOLDER:NOT-ISSUED-BY-ANY-REGISTRAR`, so
 * anything that logs or displays the issuer shows what it is. Never use it outside `TEST`, and
 * never present it as evidence of conformance.
 *
 * ## What the engine actually requires
 *
 * Verified against EUDIPLO v7.6.0 on 11 September 2026:
 *
 *   * The certificate must carry an **authorised-credentials claim**. Without it the engine
 *     refuses with `Registration certificate has no authorized credentials` — which is the
 *     engine-side over-asking check, and the reason `--vct`/`--claim` must mirror the policy.
 *   * `exp` must be in the future; the engine validates expiry.
 *
 * The key pair is generated per run and **discarded** — nothing signs anything that matters, and
 * no key material is written to disk.
 */
import { createSign, generateKeyPairSync } from "node:crypto";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const all = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i += 1)
    if (args[i] === `--${name}` && args[i + 1]) out.push(args[i + 1]);
  return out;
};

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    "usage: make-test-registration-certificate.mjs --service <id> [--vct <vct>] [--claim <path> ...]\n" +
      "       [--doctype <doctype>] [--privacy-policy <uri>] [--purpose <text>] [--ttl <seconds>]\n",
  );
  process.exit(0);
}

const serviceIdentifier = arg("service");
if (!serviceIdentifier) {
  process.stderr.write("--service <serviceIdentifier> is required.\n");
  process.exit(2);
}

const vct = arg("vct", "urn:eudi:pid:1");
const doctype = arg("doctype");
const claims = all("claim");
if (claims.length === 0) claims.push("birthdate");
const ttl = Number.parseInt(arg("ttl", "86400"), 10);

// The authorised-credentials claim, mirroring the DCQL the policy compiles to. The engine checks
// the request's credentials against this, so a narrower certificate correctly refuses a broader
// request — which is the behaviour worth having even from a placeholder.
const credential = doctype
  ? {
      id: `${doctype.replaceAll(".", "-")}-mdoc`,
      format: "mso_mdoc",
      meta: { doctype_value: doctype },
      claims: claims.map((c) => ({ path: c.split(".") })),
    }
  : {
      id: `${vct.replaceAll(":", "-")}-sdjwt`,
      format: "dc+sd-jwt",
      meta: { vct_values: [vct] },
      claims: claims.map((c) => ({ path: c.split(".") })),
    };

const now = Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

const header = b64({ alg: "ES256", typ: "rc+jwt" });
const payload = b64({
  iss: "urn:edtp:TEST-PLACEHOLDER:NOT-ISSUED-BY-ANY-REGISTRAR",
  sub: serviceIdentifier,
  privacy_policy: arg("privacy-policy", "https://verifier.example/privacy"),
  support_uri: arg("support-uri", "https://verifier.example/support"),
  purpose: [
    {
      lang: "en",
      content: arg(
        "purpose",
        "TEST PLACEHOLDER registration certificate — not issued by a Registrar",
      ),
    },
  ],
  credentials: [credential],
  iat: now,
  exp: now + ttl,
});

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const signer = createSign("SHA256");
signer.update(`${header}.${payload}`);
const signature = signer
  .sign({ key: privateKey, dsaEncoding: "ieee-p1363" })
  .toString("base64url");

process.stdout.write(`${header}.${payload}.${signature}`);
