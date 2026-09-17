#!/usr/bin/env node
/**
 * Loads a published ETSI TS 119 602 list of attestation issuers into the engine, so presentations
 * can be verified against it.
 *
 *   node scripts/load-issuer-trust-list.mjs \
 *     --tenant rpi-2 \
 *     --lote https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/PIDProviders.jwt \
 *     --signer-sha256 2IMmoFLUHyrtG60cldjIwVrvsEonpHlw9NhOqlfYUSo \
 *     --id eudi-dev-pid-providers
 *
 * Then add `<lote URL>=<id>` to ENGINE_ISSUER_TRUST_LISTS in .env and recreate platform-api. A
 * presentation policy names the URL as a trust anchor source. Re-run it when the list rolls over:
 * it updates the engine's copy in place.
 *
 * ## Why the engine does not simply fetch the URL
 *
 * It would, and it cannot read what it fetches. The notified EUDI lists carry `crit: ["sigT"]` in
 * their protected header, and the engine verifies them with `jose`, which refuses any critical
 * header it does not recognise — `ERR_JOSE_NOT_SUPPORTED`. So a policy pointing the engine at the
 * notified PID list by URL fails every presentation as "trust list unavailable". This script does
 * what the engine cannot: it checks the list's signature itself, against a **pinned** signer, and
 * loads the issuance-service certificates into a list the engine holds and re-signs.
 * `docs/interop-findings.md` A30.
 *
 * ## What it checks, in order, and refuses on
 *
 *   1. `alg` is ES256 and every `crit` entry is one it understands (`sigT` only);
 *   2. the SHA-256 thumbprint of the signing certificate equals `--signer-sha256` — the pin is the
 *      trust decision, and a list whose signer changed is refused rather than followed;
 *   3. the signature verifies;
 *   4. `NextUpdate` is in the future.
 *
 * Only services whose type ends in `/Issuance` are loaded — revocation services sign status, not
 * attestations. The engine models an entity as an issuer certificate plus a revocation certificate
 * and types every entity it builds as EAA issuance; the same certificate stands for both, and the
 * PID/EAA distinction is kept by keeping one list per trust domain, never by the engine.
 *
 * TEST only. The notified lists of the EUDI development environment are development lists.
 */
import { createHash, createPrivateKey, verify, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const tenant = arg("tenant");
const loteUrl = arg("lote");
const pin = arg("signer-sha256");
const listId = arg("id");
const description = arg("description", `Issuers from ${loteUrl ?? "?"} (TEST)`);
const engine = arg("engine", process.env.ENGINE_BASE_URL ?? "http://localhost:3000");
const caDir = arg(
  "ca-dir",
  process.env.EDTP_DEV_CA_DIR ?? join(homedir(), ".edtp", "dev-access-ca"),
);
if (!tenant || !loteUrl || !pin || !listId) {
  fail(
    "usage: --tenant <engine tenant> --lote <https URL> --signer-sha256 <b64url> --id <list id>",
  );
}
if (!loteUrl.startsWith("https://")) fail("the list URL must be https");

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const pem = (der64) =>
  `-----BEGIN CERTIFICATE-----\n${der64.match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;

// --- the list ---------------------------------------------------------------------------------
console.log(`==> Fetching ${loteUrl}`);
const res = await fetch(loteUrl, { signal: AbortSignal.timeout(30_000) });
if (!res.ok) fail(`fetch failed: HTTP ${res.status}`);
const jws = (await res.text()).trim();
const [h, p, sig] = jws.split(".");
if (!h || !p || !sig) fail("not a compact JWS");

const header = decode(h);
if (header.alg !== "ES256") fail(`unsupported alg ${header.alg}`);
const unknownCrit = (header.crit ?? []).filter((name) => name !== "sigT");
if (unknownCrit.length > 0) fail(`unrecognised critical header(s): ${unknownCrit.join(", ")}`);
if (!Array.isArray(header.x5c) || header.x5c.length === 0) fail("no x5c in the list header");

const signerDer = Buffer.from(header.x5c[0], "base64");
const thumbprint = b64url(createHash("sha256").update(signerDer).digest());
if (thumbprint !== pin)
  fail(`signer thumbprint ${thumbprint} does not match the pin — refused`);
const signer = new X509Certificate(signerDer);
const signatureValid = verify(
  "sha256",
  Buffer.from(`${h}.${p}`, "ascii"),
  { key: signer.publicKey, dsaEncoding: "ieee-p1363" },
  Buffer.from(sig, "base64url"),
);
if (!signatureValid) fail("signature does not verify — refused");
console.log(`    signed by ${signer.subject.replace(/\n/g, ", ")} (pinned)`);

const lote = decode(p).LoTE;
const nextUpdate = new Date(lote?.ListAndSchemeInformation?.NextUpdate ?? 0);
if (!(nextUpdate.getTime() > Date.now()))
  fail("the list is stale (NextUpdate not in the future)");
console.log(`    next update ${nextUpdate.toISOString()}`);

const seen = new Set();
const entities = [];
for (const entity of lote.TrustedEntitiesList ?? []) {
  for (const service of entity.TrustedEntityServices ?? []) {
    const info = service.ServiceInformation;
    if (!String(info?.ServiceTypeIdentifier ?? "").endsWith("/Issuance")) continue;
    for (const cert of info.ServiceDigitalIdentity?.X509Certificates ?? []) {
      if (seen.has(cert.val)) continue;
      seen.add(cert.val);
      const certPem = pem(cert.val);
      entities.push({
        type: "external",
        providerType: "attestation-provider",
        issuerCertPem: certPem,
        revocationCertPem: certPem,
        info: { name: info.ServiceName?.[0]?.value ?? "issuer", lang: "en", country: "EU" },
      });
    }
  }
}
if (entities.length === 0) fail("the list holds no issuance service");
console.log(`    ${entities.length} issuance certificate(s)`);

// --- the engine -------------------------------------------------------------------------------
const envLine = readFileSync(".env", "utf8")
  .split("\n")
  .find((line) => line.startsWith("ENGINE_TENANT_CREDENTIALS="));
const entry = (envLine ?? "")
  .slice("ENGINE_TENANT_CREDENTIALS=".length)
  .split(",")
  .find((e) => e.startsWith(`${tenant}=`));
if (!entry) fail(`no ENGINE_TENANT_CREDENTIALS entry for ${tenant} in .env`);
const pair = entry.slice(tenant.length + 1);
const tokenRes = await fetch(`${engine}/api/oauth2/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: pair.slice(0, pair.indexOf(":")),
    client_secret: pair.slice(pair.indexOf(":") + 1),
  }),
});
const token = tokenRes.ok ? (await tokenRes.json()).access_token : undefined;
if (!token) fail(`could not obtain an engine token for ${tenant}`);
const api = (method, path, body) =>
  fetch(`${engine}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

console.log(`==> Engine tenant ${tenant}`);
const keys = await (await api("GET", "/key-chain")).json();
if (!keys.some((k) => k.usageType === "trustList")) {
  // The engine re-signs every list it holds, so it needs a trustList key first. The development
  // LoTE signer, as scripts/setup-wallet-provider-trust.sh uses — read locally, sent once.
  const key = createPrivateKey(readFileSync(join(caDir, "lote-signer.key"), "utf8"));
  const imported = await api("POST", "/key-chain/import", {
    usageType: "trustList",
    description: "EDTP development LoTE signer (TEST)",
    key: key.export({ format: "jwk" }),
    crt: [readFileSync(join(caDir, "lote-signer.crt"), "utf8")],
  });
  if (imported.status !== 201) fail(`trustList key import failed: HTTP ${imported.status}`);
  console.log("    imported a trustList signing key");
}

const exists = (await api("GET", `/trust-list/${encodeURIComponent(listId)}`)).status === 200;
const body = { id: listId, description, entities };
const written = exists
  ? await api("PUT", `/trust-list/${encodeURIComponent(listId)}`, body)
  : await api("POST", "/trust-list", body);
if (![200, 201].includes(written.status)) {
  fail(
    `trust list write failed: HTTP ${written.status} ${(await written.text()).slice(0, 300)}`,
  );
}
console.log(`    ${exists ? "updated" : "created"} ${listId}`);
console.log();
console.log("Add to ENGINE_ISSUER_TRUST_LISTS in .env, then recreate platform-api:");
console.log(`  ${loteUrl}=${listId}`);
