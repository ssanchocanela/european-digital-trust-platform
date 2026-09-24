#!/usr/bin/env node
/**
 * Sets up issuance of the three Power of X attestations, from a verified PID plus test data.
 *
 * ## What it creates
 *
 * 1. A presentation policy **Identify with PID, for a Power of X credential**, alongside the
 *    identification policy it is given — same Relying Party Service, same intended use — asking the
 *    PID for what a natural-person proxy must carry: names, date of birth, nationalities, country of
 *    birth. A separate policy rather than a new version of the existing one, so identifying for
 *    anything else does not start asking for more.
 * 2. For each of Power of Representation, Power of Attorney and Power of Employee: a credential type
 *    with its claims **and its payload schema**, and a published issuance policy whose source is
 *    `verified-presentation` — the proxy's identity from the presentation, everything else fixed.
 *
 * ## Where the definitions come from
 *
 * Not from this repository. They derive from a consortium Rulebook draft whose content stays
 * outside it (`docs/credential-catalogue.md`), so this script reads them from files the operator
 * supplies:
 *
 *     EDTP_POX_ISSUANCE=~/.edtp/credential-catalogue/pox-issuance.json
 *
 * which names its payload schema (`payloadSchemaFile`) in the same directory. Absent the file the
 * script stops; it never invents definitions.
 *
 * ## What the result is, and is not
 *
 * **Every fixed value is fictitious test data.** The organisation, the position, the powers and the
 * grantor exist nowhere, and the source is a FIXTURE: each issuance carries the fixture warning.
 * The attestations prove the platform can issue this structure, and nothing about anyone's authority
 * to act for anyone. `TEST` environment only.
 *
 * ## Usage
 *
 *   PLATFORM_TENANT_API_KEY=… node scripts/register-pox-issuance.mjs \
 *     <attestationProviderId> <identificationPresentationPolicyId>
 *
 * The key is a credential and must not be an argument: arguments are visible in the process list and
 * land in shell history.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const KEY = process.env.PLATFORM_TENANT_API_KEY;
const [providerId, identifyPolicyId] = process.argv.slice(2);

if (!KEY) {
  process.stderr.write(
    "Set PLATFORM_TENANT_API_KEY. It is a secret and must not be an argument.\n",
  );
  process.exit(1);
}
if (!providerId || !identifyPolicyId) {
  process.stderr.write(
    "usage: node scripts/register-pox-issuance.mjs <attestationProviderId> " +
      "<identificationPresentationPolicyId>\n",
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
    const details = parsed.details ? ` ${JSON.stringify(parsed.details)}` : "";
    throw new Error(
      `${method} ${path} → ${response.status} ${parsed.message ?? text}${details}`,
    );
  }
  return parsed;
};

const load = () => {
  const path =
    process.env.EDTP_POX_ISSUANCE ??
    `${process.env.HOME}/.edtp/credential-catalogue/pox-issuance.json`;
  if (!existsSync(path)) {
    throw new Error(
      `No Power of X issuance definitions at ${path}. They derive from a Rulebook whose content stays ` +
        "outside this repository; supply the file, or set EDTP_POX_ISSUANCE.",
    );
  }
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const schema = JSON.parse(readFileSync(join(dirname(path), doc.payloadSchemaFile), "utf8"));
  // The schema describes the attestation as a verifier sees it. The platform checks the claims
  // before the engine adds `iss`, `iat`, `exp`, `cnf` and `status`, so those cannot be required yet.
  const engineAdded = new Set(["iss", "iat", "exp", "cnf", "status"]);
  const payloadSchema = {
    ...schema,
    required: schema.required.filter((k) => !engineAdded.has(k)),
  };
  return { doc, payloadSchema, path };
};

const main = async () => {
  const { doc, payloadSchema, path } = load();
  const { tenantId } = await api("GET", "/v1/me");
  const t = encodeURIComponent(tenantId);

  // --- 1. The identification policy -----------------------------------------------------------
  const identify = await api(
    "GET",
    `/v1/tenants/${t}/presentation-policies/${encodeURIComponent(identifyPolicyId)}`,
  );
  const latest = [...identify.versions]
    .filter((v) => v.status === "PUBLISHED")
    .sort((a, b) => b.version - a.version)[0];
  if (!latest)
    throw new Error(`Presentation policy ${identifyPolicyId} has no published version.`);

  const idSpec = doc.identification;
  const policy = await api("POST", `/v1/tenants/${t}/presentation-policies`, {
    relyingPartyServiceId: identify.relyingPartyServiceId,
    intendedUseId: identify.intendedUseId,
    name: idSpec.name,
    description:
      "Identifies the proxy before a Power of X credential is issued from the presentation. " +
      "Asks for what a natural-person proxy must carry, and nothing else.",
  });
  const idVersion = await api(
    "POST",
    `/v1/tenants/${t}/presentation-policies/${encodeURIComponent(policy.policyId)}/versions`,
    {
      purpose: idSpec.purpose,
      credentialRequirements: latest.credentialRequirements,
      requestedClaims: idSpec.requestedClaims.map((p) => ({ path: p })),
      resultPolicy: { kind: "VERIFIED_CLAIMS", allowedClaims: idSpec.requestedClaims },
      trustPolicy: { anchorSources: idSpec.anchorSources, statusCheckMode: "STRICT" },
      publish: true,
    },
  );
  process.stdout.write(
    `Identification policy ${policy.policyId} v${idVersion.version} (${idVersion.status})\n\n`,
  );

  // --- 2. The three credential types and their issuance policies ----------------------------------
  for (const type of doc.types) {
    const created = await api("POST", `/v1/tenants/${t}/credential-types`, {
      attestationProviderId: providerId,
      name: type.name,
      format: "dc+sd-jwt",
      vct: type.vct,
      rulebook: doc.rulebook,
      claims: type.claims,
      display: type.display,
      validitySeconds: doc.validitySeconds,
      statusMechanism: "TOKEN_STATUS_LIST",
      requiresKeyBinding: true,
      payloadSchema,
    });
    const issuancePolicy = await api("POST", `/v1/tenants/${t}/issuance-policies`, {
      credentialTypeId: created.credentialTypeId,
      name: `${type.name} — from a verified PID`,
    });
    // Only the claims the PID supplies are mapped; everything else is fixed test data.
    const mapped = Object.fromEntries(
      Object.entries(doc.fromPid).filter(([claim]) =>
        type.claims.some((c) => c.path.join(".") === claim),
      ),
    );
    const version = await api(
      "POST",
      `/v1/tenants/${t}/issuance-policies/${encodeURIComponent(issuancePolicy.policyId)}/versions`,
      {
        credentialTypeId: created.credentialTypeId,
        purpose: type.display,
        eligibilityRule: { evaluator: "AlwaysEligible", parameters: {} },
        authenticSource: {
          connector: "verified-presentation",
          parameters: {
            claimsFromPresentation: mapped,
            fixedClaims: type.fixedClaims,
            maxAgeSeconds: 900,
          },
        },
        holderBinding: "KEY_BOUND",
        flow: "PRE_AUTHORIZED_CODE",
        // Rulebook "standard expiry": two years. Expiry linked to a shorter position or power is
        // not computed per attestation (pox-data-model.md D7); the test data has none shorter.
        credentialValiditySeconds: doc.validitySeconds,
        // The Rulebook provides for revocation and not for suspension.
        statusPolicy: { statusListEnabled: true, suspensionAllowed: false },
        publish: true,
      },
    );
    process.stdout.write(
      `  ${type.key.toUpperCase()}  ${type.vct.padEnd(44)} type ${created.credentialTypeId}\n` +
        `       issuance policy ${issuancePolicy.policyId} v${version.version}\n`,
    );
  }

  process.stdout.write(
    `\nDefinitions loaded from ${path}; their claim paths, vct values and schema are this project's\n` +
      "interpretation of the Rulebook. Every fixed value is FICTITIOUS test data and the source is a\n" +
      "FIXTURE. TEST environment only.\n\n" +
      "To issue: present a PID against the identification policy above, then request issuance with\n" +
      "the presentation id as subjectReference — or press Issue on the presentation's console page.\n",
  );
};

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
