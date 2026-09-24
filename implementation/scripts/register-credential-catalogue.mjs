#!/usr/bin/env node
/**
 * Registers the credentials a Relying Party Service may ask for.
 *
 * ## What this is, and what it is not
 *
 * An **intended use** records what a Registrar authorised a Relying Party to request. The platform
 * validates every published policy against it — extending a registered claim path is allowed,
 * prefixing it is not — so it is the bound on everything the console can offer.
 *
 * **This script does not register anything with a Registrar.** It records, in a `TEST` environment,
 * what a registration *would* say, so the rest of the platform can be built and operated. Nothing it
 * writes is evidence that any authority authorised anything.
 *
 * ## Where each catalogue entry comes from
 *
 * **PID and mDL** are read from the live reference issuer's own
 * `credential_configurations_supported` and are held here, because they are public and because a
 * claim path that does not match what a wallet in this environment holds fails at the phone and
 * looks like a wallet problem.
 *
 * **Power of X** is not held here. Those definitions derive from a consortium Rulebook draft
 * supplied to this project, whose content stays outside the repository — this script loads them from
 * a file the operator supplies:
 *
 *     EDTP_POX_CATALOGUE=~/.edtp/credential-catalogue/pox.json
 *
 * Absent that file the script registers PID and mDL and says what it skipped. It never invents the
 * missing entries, because a catalogue that quietly registered something different from the Rulebook
 * would be worse than one that registered less.
 *
 * The interpretation those definitions embody is this project's and is recorded in
 * `docs/credential-catalogue.md`: the Rulebook specifies SD-JWT VC but gives neither a JSON schema
 * nor a `vct`, so both the claim paths and the type identifiers had to be chosen here.
 *
 * ## Usage
 *
 *   PLATFORM_TENANT_API_KEY=… node scripts/register-credential-catalogue.mjs <serviceId> [identifier]
 *
 * The key is a credential and must not be an argument: arguments are visible in the process list and
 * land in shell history.
 */

import { existsSync, readFileSync } from "node:fs";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const KEY = process.env.PLATFORM_TENANT_API_KEY;
const serviceId = process.argv[2];
const identifier = process.argv[3] ?? `catalogue-${Date.now().toString(36)}`;

if (!KEY) {
  process.stderr.write(
    "Set PLATFORM_TENANT_API_KEY. It is a secret and must not be an argument.\n",
  );
  process.exit(1);
}
if (!serviceId) {
  process.stderr.write(
    "usage: node scripts/register-credential-catalogue.mjs <relyingPartyServiceId> [identifier]\n",
  );
  process.exit(1);
}

const api = async (method, path, body) => {
  const response = await fetch(new URL(path, BASE_URL), {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${parsed.message ?? text}`);
  }
  return parsed;
};

// --- PID, as the reference issuer advertises it -------------------------------------------------
//
// Note what is NOT here: any `age_over_*`. The PID Rulebook removed age verification attributes
// following CIR 2024/2977, and the live issuer advertises none. An age check against a PID is
// derived from `birthdate`, with the date discarded in the same call stack.
const PID = {
  format: "dc+sd-jwt",
  vctValues: ["urn:eudi:pid:1"],
  claims: [
    ["family_name"],
    ["given_name"],
    ["birthdate"],
    ["place_of_birth"],
    ["nationalities"],
    ["address", "locality"],
    ["address", "country"],
    ["personal_administrative_number"],
    ["date_of_expiry"],
    ["issuing_country"],
  ],
};

// --- mDL ----------------------------------------------------------------------------------------
//
// The mDL **does** carry `age_over_18`, unlike the PID. So an age check against an mDL asks for the
// attribute and against a PID derives it — the same question, two different policies, and the
// difference is the Rulebook's rather than ours.
const MDL = {
  format: "mso_mdoc",
  doctype: "org.iso.18013.5.1.mDL",
  claims: [
    ["org.iso.18013.5.1", "family_name"],
    ["org.iso.18013.5.1", "given_name"],
    ["org.iso.18013.5.1", "birth_date"],
    ["org.iso.18013.5.1", "age_over_18"],
    ["org.iso.18013.5.1", "document_number"],
    ["org.iso.18013.5.1", "driving_privileges"],
    ["org.iso.18013.5.1", "expiry_date"],
    ["org.iso.18013.5.1", "issuing_country"],
    ["org.iso.18013.5.1", "issuing_authority"],
  ],
};

// --- Power of X, loaded rather than held --------------------------------------------------------
//
// See the header. The file's shape is `{ entries: [{ label, credential }] }`, where `credential` is
// exactly what an intended use registers: `{ format, vctValues?, doctype?, claims }`.
const loadPox = () => {
  const path =
    process.env.EDTP_POX_CATALOGUE ?? `${process.env.HOME}/.edtp/credential-catalogue/pox.json`;
  if (!existsSync(path)) return { entries: [], path };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed.entries)) {
    throw new Error(`${path} has no \`entries\` array.`);
  }
  return { entries: parsed.entries, path };
};

const pox = loadPox();
const CATALOGUE = [
  ["PID (SD-JWT VC)", PID],
  ["mDL (mdoc)", MDL],
  ...pox.entries.map((e) => [e.label, e.credential]),
];

const main = async () => {
  process.stdout.write(`Registering a catalogue on Service ${serviceId}\n\n`);

  const { tenantId } = await api("GET", "/v1/me");
  const created = await api(
    "POST",
    `/v1/tenants/${encodeURIComponent(tenantId)}/rp-services/${encodeURIComponent(serviceId)}/intended-uses`,
    {
      intendedUseIdentifier: identifier,
      purpose: [
        {
          lang: "en",
          value:
            "Verify a person's identity, driving entitlement, or authority to act for a company",
        },
      ],
      privacyPolicyUris: [{ lang: "en", value: "https://example.test/privacy" }],
      registeredCredentials: CATALOGUE.map(([, c]) => c),
    },
  );

  for (const [label, c] of CATALOGUE) {
    const id = c.vctValues?.[0] ?? c.doctype;
    process.stdout.write(
      `  ${label.padEnd(26)} ${String(id).padEnd(44)} ${c.claims.length} claims\n`,
    );
  }

  process.stdout.write(`\nIntended use ${created.intendedUseId} (${identifier}).\n`);
  process.stdout.write(
    "\nThis records what a registration would authorise. It is not a registration, and nothing here\n" +
      "is evidence that any authority authorised anything. TEST environment only.\n",
  );
  if (pox.entries.length === 0) {
    process.stdout.write(
      `\nNo Power of X definitions: nothing at ${pox.path}. Those derive from a Rulebook whose content\n` +
        "stays outside this repository; supply the file, or set EDTP_POX_CATALOGUE, to register them.\n",
    );
  } else {
    process.stdout.write(
      `\nPower of X loaded from ${pox.path}. Its claim paths and vct values are this project's\n` +
        "interpretation — see docs/credential-catalogue.md before relying on them.\n",
    );
  }
};

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
