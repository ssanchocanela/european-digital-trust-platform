#!/usr/bin/env node
/**
 * Builds and signs an EDTP **TEST** list of Wallet-Relying Party Access Certificate providers
 * (`--kind wrpac`, the default) or of PID Providers (`--kind pid`), per ETSI TS 119 602, as the JWS
 * a Wallet Unit consults.
 *
 *   node scripts/make-test-lote.mjs \
 *     --ca ~/.edtp/dev-access-ca/ca.crt \
 *     --url https://ssanchocanela.github.io/european-digital-trust-platform/lote/WRPACProviders.jwt \
 *     --out docs/public/lote/WRPACProviders.jwt
 *
 *   node scripts/make-test-lote.mjs --kind pid \
 *     --ca ~/.edtp/dev-pid-ca/ca.crt \
 *     --url https://ssanchocanela.github.io/european-digital-trust-platform/lote/PIDProviders.jwt \
 *     --out docs/public/lote/PIDProviders.jwt
 *
 * ## The PID list (`--kind pid`)
 *
 * The same construction for a different trust domain: the notified `PIDProviders` anchors plus our
 * development PID Provider CA (`scripts/make-dev-pid-ca.sh`). It serves two readers — the engine, which
 * loads it with `scripts/load-issuer-trust-list.mjs` so a presentation of our test PID verifies, and a
 * wallet built with deviation **WD-4**, whose `pidProviders` is, like `wrpacProviders`, a single `Uri`
 * and so is replaced rather than extended. Both kinds share one signer: the signer vouches for the
 * list's integrity, not for either domain, and the domains stay apart because the lists do.
 *
 * ## This is not a notified list, and it says so in every field that is displayed
 *
 * ARF Topic 31 lists are notified by Member States. This one is not and never will be. It exists
 * because Path A failed — the reference Registrar cannot issue an access certificate at all
 * (`docs/interop-findings.md` C10) — so a *modified* wallet has to be pointed at a list we control.
 * That is deviation **WD-3** in `tools/test-wallet/deviations.md`, and a result obtained with it is
 * a result from a modified wallet, never from "the Reference Wallet".
 *
 * `CLAUDE.md` §6 item 16 is the basis for publishing one at all: anchors may come from a list
 * published per ETSI TS 119 602 that is **not** a Topic 31 notified list. `TEST` only.
 *
 * ## Why it copies the notified list instead of starting empty
 *
 * `SupportedLists.wrpacProviders` is a **single `Uri`**, not a collection. Pointing it at our list
 * therefore *replaces* the notified one — so a list containing only our anchor would make the
 * wallet distrust every real Relying Party, which is a far larger behavioural change than "trust
 * ours as well" and would make a passing test mean much less.
 *
 * So this fetches the live notified list and carries its seven anchors forward, adding ours as an
 * eighth, as a separate trusted entity. That is what makes WD-3 genuinely *additional*. It also
 * means the list must be regenerated when the notified anchors roll over — they did on
 * 10-11 September 2026 — which `--max-age-days` guards against forgetting.
 *
 * ## Why the signing key is not our Access CA
 *
 * Because the list is what *delivers* our Access CA as an anchor. Signing it with that same CA
 * would mean a wallet had to trust the CA in order to verify the list that tells it to trust the
 * CA. The signer is a separate, self-signed certificate, and whether the wallet's built-in
 * verifier accepts it is the open question WD-3 has to answer on its first build — see
 * `deviations.md`.
 */
import { execFileSync } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const KINDS = {
  wrpac: {
    notifiedList: "https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/WRPACProviders.jwt",
    serviceType: "http://uri.etsi.org/19602/SvcType/WRPAC",
    serviceName: "EDTP Development Access CA - TEST ONLY",
    schemeSubject: "WRPAC providers",
    caDir: "dev-access-ca",
    deviation: "wd-3",
    buildFlag: "--wrpac-lote",
  },
  pid: {
    notifiedList: "https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/PIDProviders.jwt",
    serviceType: "http://uri.etsi.org/19602/SvcType/PID",
    serviceName: "EDTP Development PID Provider CA - TEST ONLY",
    schemeSubject: "PID providers",
    caDir: "dev-pid-ca",
    deviation: "wd-4",
    buildFlag: "--pid-lote",
  },
};
const kindName = arg("kind", "wrpac");
const kind = KINDS[kindName];
if (!kind) {
  console.error(`--kind must be one of: ${Object.keys(KINDS).join(", ")}`);
  process.exit(1);
}
const NOTIFIED_LIST = kind.notifiedList;

const caPath = arg("ca", join(homedir(), ".edtp", kind.caDir, "ca.crt"));
const publishedUrl = arg("url");
const outPath = arg("out");
const validityDays = Number(arg("validity-days", "90"));
const maxAgeDays = Number(arg("max-age-days", "30"));
const signerDir = arg("signer-dir", join(homedir(), ".edtp", "dev-access-ca"));

if (!publishedUrl || !outPath) {
  console.error(
    "usage: make-test-lote.mjs --url <published-https-url> --out <path> [--ca <ca.crt>]",
  );
  process.exit(1);
}
if (!publishedUrl.startsWith("https://")) {
  // A wallet will not fetch a trust list over cleartext, and neither should we ask it to.
  console.error("--url must be https.");
  process.exit(1);
}

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const derOf = (pemPath) => {
  const pem = readFileSync(pemPath, "utf8");
  const body = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  if (body.length === 0) throw new Error(`${pemPath} contains no certificate`);
  return Buffer.from(body, "base64");
};

// --- 1. the notified list, live -----------------------------------------------------------
// Fetched rather than cached: the anchors roll over, and a stale copy would publish anchors a
// wallet has already stopped honouring while looking perfectly valid.

console.log(`==> Fetching the notified list\n    ${NOTIFIED_LIST}`);
const notifiedJws = (await (await fetch(NOTIFIED_LIST)).text()).trim();
const notifiedPayload = JSON.parse(
  Buffer.from(notifiedJws.split(".")[1], "base64url").toString("utf8"),
);
const notified = notifiedPayload.LoTE;
if (!notified?.ListAndSchemeInformation || !Array.isArray(notified.TrustedEntitiesList)) {
  throw new Error("the notified list is not shaped as expected; refusing to build from it");
}

const issued = notified.ListAndSchemeInformation.ListIssueDateTime;
const ageDays = (Date.now() - Date.parse(issued)) / 86_400_000;
console.log(`    issued ${issued} (${ageDays.toFixed(1)} days ago)`);
if (Number.isFinite(ageDays) && ageDays > maxAgeDays) {
  console.warn(
    `    !! the notified list is older than ${maxAgeDays} days. It may have rolled over since;\n` +
      "    !! re-check before relying on the anchors copied here.",
  );
}

const anchorCount = notified.TrustedEntitiesList.flatMap(
  (entity) => entity.TrustedEntityServices ?? [],
).filter((service) =>
  String(service.ServiceInformation?.ServiceTypeIdentifier ?? "").endsWith("/Issuance"),
).length;
console.log(`    carrying forward ${anchorCount} notified anchor(s)`);
if (anchorCount === 0) throw new Error("the notified list carried no issuance anchors");

// --- 2. our anchor, as an additional trusted entity ---------------------------------------
// A separate entity rather than another service of theirs: the anchor is ours, operated by us,
// and folding it into their entity would misattribute it.

const caDer = derOf(caPath);

/**
 * Our entry is built by **cloning the notified list's entity and replacing its values**, rather than
 * by writing the object out by hand.
 *
 * Writing it by hand is what failed on 13 September 2026: the object looked complete, the JWS
 * signature verified, and the wallet still refused the list with
 * `FailedToParseJwt: Failed to parse JWT to the expected payload`. The only structural difference
 * was a missing `TEAddress` — a field nothing in the specification reading had flagged as load
 * bearing, and which a hand-written object will keep omitting.
 *
 * Cloning inverts that: every field the real list carries comes along, including the ones we have
 * not thought about, and only the values that identify the entity are changed. Anything the parser
 * requires and we have never heard of arrives for free.
 */
const clone = (value) => JSON.parse(JSON.stringify(value));
const template = notified.TrustedEntitiesList[0];
if (!template?.TrustedEntityInformation || !template.TrustedEntityServices?.length) {
  throw new Error("the notified list has no entity to use as a template");
}

/** Replaces the `value`/`uriValue` of every localised entry, keeping the shape and languages. */
const relabel = (entries, replacement) =>
  (entries ?? []).map((entry) => ({
    ...entry,
    ...(entry.value === undefined ? {} : { value: replacement }),
    ...(entry.uriValue === undefined ? {} : { uriValue: replacement }),
  }));

const serviceTemplate = template.TrustedEntityServices[0].ServiceInformation;
const ourService = (name, typeIdentifier) => ({
  ServiceInformation: {
    ...clone(serviceTemplate),
    ServiceName: relabel(serviceTemplate.ServiceName, name),
    ServiceDigitalIdentity: { X509Certificates: [{ val: caDer.toString("base64") }] },
    ServiceTypeIdentifier: typeIdentifier,
    SchemeServiceDefinitionURI: relabel(
      serviceTemplate.SchemeServiceDefinitionURI,
      publishedUrl,
    ),
  },
});

const information = clone(template.TrustedEntityInformation);
const ourEntity = {
  TrustedEntityInformation: {
    ...information,
    TEName: relabel(information.TEName, "EDTP development — NOT a notified provider"),
    TETradeName: relabel(information.TETradeName, "European Digital Trust Platform (TEST)"),
    TEInformationURI: relabel(information.TEInformationURI, publishedUrl),
  },
  TrustedEntityServices: [
    // Issuance and Revocation, as the notified list carries for every anchor. The same certificate
    // appears in both, which is why anything counting anchors must filter on the type.
    ourService(kind.serviceName, `${kind.serviceType}/Issuance`),
    ourService(`${kind.serviceName} Revocation`, `${kind.serviceType}/Revocation`),
  ],
};

// --- 3. the list ---------------------------------------------------------------------------
// The scheme identity is rewritten, deliberately and thoroughly. Everything structural is
// inherited from the notified list so a wallet's parser sees the shape it expects; everything a
// human or a log would read says whose list this is. A list that kept "EU WRPAC Providers List"
// while containing our anchor would be the single most misleading artefact in this repository.

const now = new Date();
const nextUpdate = new Date(now.getTime() + validityDays * 86_400_000);
const iso = (date) => `${date.toISOString().slice(0, 19)}Z`;

const lote = {
  LoTE: {
    ListAndSchemeInformation: {
      ...notified.ListAndSchemeInformation,
      LoTESequenceNumber: (notified.ListAndSchemeInformation.LoTESequenceNumber ?? 0) + 1,
      ListIssueDateTime: iso(now),
      NextUpdate: iso(nextUpdate),
      SchemeOperatorName: [
        { lang: "en", value: "European Digital Trust Platform — development operator" },
      ],
      SchemeName: [
        {
          lang: "en",
          value:
            `EDTP TEST list of ${kind.schemeSubject} — NOT NOTIFIED, NOT the EU list, ` +
            "for development testing only",
        },
      ],
      SchemeInformationURI: [{ lang: "en", uriValue: publishedUrl }],
      SchemeTerritory: "ES",
    },
    TrustedEntitiesList: [...notified.TrustedEntitiesList, ourEntity],
  },
};

// --- 4. the signer -------------------------------------------------------------------------

mkdirSync(signerDir, { recursive: true, mode: 0o700 });
const signerKeyPath = join(signerDir, "lote-signer.key");
const signerCertPath = join(signerDir, "lote-signer.crt");

if (!existsSync(signerCertPath)) {
  console.log("==> Creating the list signing certificate (self-signed, separate from the CA)");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  writeFileSync(signerKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  execFileSync("openssl", [
    "req",
    "-new",
    "-x509",
    "-key",
    signerKeyPath,
    "-out",
    signerCertPath,
    "-days",
    "730",
    "-sha256",
    "-subj",
    "/CN=EDTP TEST LoTE Signer - NOT A NOTIFIED SCHEME OPERATOR/O=EDTP development/C=ES",
  ]);
}

const signerKey = readFileSync(signerKeyPath, "utf8");
const signerDer = derOf(signerCertPath);

// --- 5. sign -------------------------------------------------------------------------------
// The header mirrors the profile the notified lists use: ES256, the signer in `x5c`, and a JAdES
// `sigT` marked critical. Imitating it is not cosmetic — a verifier written against those lists
// may well require `typ`, `cty` or `sigT`, and a list that omits them would fail for a reason
// unrelated to trust.

const header = {
  alg: "ES256",
  cty: "octet-stream",
  typ: "jose+json",
  x5c: [signerDer.toString("base64")],
  sigT: iso(now),
  crit: ["sigT"],
};

const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(lote))}`;
const signature = createSign("SHA256")
  .update(signingInput)
  // JWS requires the raw R||S pair; the default DER encoding would be rejected.
  .sign({ key: signerKey, dsaEncoding: "ieee-p1363" })
  .toString("base64url");

const jws = `${signingInput}.${signature}`;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${jws}\n`);

const totalAnchors = lote.LoTE.TrustedEntitiesList.flatMap(
  (entity) => entity.TrustedEntityServices ?? [],
).filter((service) =>
  String(service.ServiceInformation?.ServiceTypeIdentifier ?? "").endsWith("/Issuance"),
).length;

console.log(`
==> Written ${outPath}
    anchors        ${totalAnchors} (${anchorCount} notified, carried forward + 1 ours)
    issued         ${iso(now)}
    next update    ${iso(nextUpdate)}
    published at   ${publishedUrl}
    signer         ${signerCertPath}

This list is NOT notified. It must be served only at the URL above, only over HTTPS, and only to
a wallet built with ${kind.deviation.toUpperCase()}. Point a build at it with:

    tools/test-wallet/build.sh --deviations ${kind.deviation} ${kind.buildFlag} ${publishedUrl}

Regenerate it when the notified anchors roll over — they last did on 10-11 September 2026 — or the
seven anchors copied here will drift out of date while the list still looks valid.
`);
