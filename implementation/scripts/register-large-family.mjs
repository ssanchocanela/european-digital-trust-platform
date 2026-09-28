#!/usr/bin/env node
/**
 * Sets up the **Título de Familia Numerosa** (Large Family Title) demonstration: issued by a
 * fictitious autonomous community after the holder identifies with their PID, and presented to a
 * fictitious fibre operator for a discount.
 *
 * ## Two commands
 *
 *   PLATFORM_TENANT_API_KEY=… node scripts/register-large-family.mjs issuance \
 *     <attestationProviderId> <identificationPresentationPolicyId>
 *
 * 1. A presentation policy **Identify with PID, for a Large Family Title**, alongside the
 *    identification policy it is given — same Relying Party Service, intended use, credential
 *    requirement and trust anchors — asking the PID for names and date of birth, nothing else.
 * 2. The credential type, with its claims and payload schema, and a published issuance policy whose
 *    source is `verified-presentation`: the member's identity from the presentation, everything
 *    else fixed.
 *
 *   PLATFORM_TENANT_API_KEY=… node scripts/register-large-family.mjs presentation \
 *     <relyingPartyServiceId> <eaaTrustListUrl>
 *
 * 3. A **new** intended use registering the type — an existing one is never edited
 *    (`docs/credential-catalogue.md`, *Adding to the catalogue*) — and the policy the fibre operator
 *    uses: category and expiry date, and nothing else. The issuer anchor is the EDTP TEST list of
 *    non-qualified EAA providers, which must carry the issuing provider's certificate.
 *
 * ## Where the definition comes from
 *
 * `scripts/large-family/large-family-title.json`, in this repository. Unlike the Power of X
 * definitions it derives from no confidential draft: it is this project's own model of the title the
 * communities issue under Ley 40/2003 and RD 1621/2005, and says so in its `_note`.
 *
 * ## What the result is, and is not
 *
 * **Every fixed value is fictitious test data**, and the source is a FIXTURE: each issuance carries
 * the fixture warning. The attestation proves the platform can issue and verify this structure, and
 * nothing about anyone's family. `TEST` environment only.
 *
 * The key is a credential and must not be an argument: arguments are visible in the process list and
 * land in shell history.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const KEY = process.env.PLATFORM_TENANT_API_KEY;
const [command, ...rest] = process.argv.slice(2);

const USAGE =
  "usage: node scripts/register-large-family.mjs issuance <attestationProviderId> <identificationPolicyId>\n" +
  "       node scripts/register-large-family.mjs presentation <relyingPartyServiceId> <eaaTrustListUrl>\n";

if (!KEY) {
  process.stderr.write(
    "Set PLATFORM_TENANT_API_KEY. It is a secret and must not be an argument.\n",
  );
  process.exit(1);
}
if (!["issuance", "presentation"].includes(command) || rest.length !== 2) {
  process.stderr.write(USAGE);
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

const DEFINITION = join(
  dirname(fileURLToPath(import.meta.url)),
  "large-family",
  "large-family-title.json",
);
const doc = JSON.parse(readFileSync(DEFINITION, "utf8"));

const issuance = async (t, providerId, identifyPolicyId) => {
  // --- 1. The identification policy, copied from an existing PID one --------------------------
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
      "Identifies the family member before a Large Family Title is issued from the presentation. " +
      "Asks for names and date of birth, and nothing else.",
  });
  const idVersion = await api(
    "POST",
    `/v1/tenants/${t}/presentation-policies/${encodeURIComponent(policy.policyId)}/versions`,
    {
      purpose: idSpec.purpose,
      credentialRequirements: latest.credentialRequirements,
      requestedClaims: idSpec.requestedClaims.map((p) => ({ path: p })),
      resultPolicy: { kind: "VERIFIED_CLAIMS", allowedClaims: idSpec.requestedClaims },
      // The same PID anchors as the policy copied, so a test PID identifies here exactly as it
      // does for the representation credentials.
      trustPolicy: latest.trustPolicy,
      publish: true,
    },
  );

  // --- 2. The credential type and its issuance policy ----------------------------------------
  const type = doc.type;
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
    payloadSchema: doc.payloadSchema,
  });
  const issuancePolicy = await api("POST", `/v1/tenants/${t}/issuance-policies`, {
    credentialTypeId: created.credentialTypeId,
    name: `${type.name} — from a verified PID`,
  });
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
          claimsFromPresentation: doc.fromPid,
          fixedClaims: type.fixedClaims,
          maxAgeSeconds: 900,
        },
      },
      holderBinding: "KEY_BOUND",
      flow: "PRE_AUTHORIZED_CODE",
      // One year, shorter than the title's own validity (`date_of_expiry`): the attestation may
      // expire before the title, never after it.
      credentialValiditySeconds: doc.validitySeconds,
      // A title is revoked when the family stops qualifying; the law provides no suspension.
      statusPolicy: { statusListEnabled: true, suspensionAllowed: false },
      publish: true,
    },
  );

  process.stdout.write(
    `Identification policy ${policy.policyId} v${idVersion.version} (${idVersion.status})\n` +
      `Credential type       ${created.credentialTypeId}  ${type.vct}\n` +
      `Issuance policy       ${issuancePolicy.policyId} v${version.version} (${version.status})\n\n` +
      "For the hosted form, add to HOSTED_FORM_POLICIES:\n" +
      `  <tenantId>:${issuancePolicy.policyId}:${policy.policyId}\n` +
      "then provision it: POST /v1/tenants/<t>/issuance-policies/<id>/provision.\n",
  );
};

const presentation = async (t, serviceId, trustListUrl) => {
  if (!trustListUrl.startsWith("https://")) throw new Error("the trust list URL must be https");
  const spec = doc.presentation;
  const claims = doc.type.claims.map((c) => c.path);

  // --- 3. A new intended use, then the fibre operator's policy -------------------------------
  const use = await api(
    "POST",
    `/v1/tenants/${t}/rp-services/${encodeURIComponent(serviceId)}/intended-uses`,
    {
      intendedUseIdentifier: spec.intendedUseIdentifier,
      purpose: spec.intendedUsePurpose,
      privacyPolicyUris: [{ lang: "en", value: "https://example.test/privacy" }],
      registeredCredentials: [{ format: "dc+sd-jwt", vctValues: [doc.type.vct], claims }],
    },
  );
  const policy = await api("POST", `/v1/tenants/${t}/presentation-policies`, {
    relyingPartyServiceId: serviceId,
    intendedUseId: use.intendedUseId,
    name: spec.name,
    description: spec.description,
  });
  // Validated against the intended use before it is stored: a path outside what it registers is
  // refused with 422 and named.
  const version = await api(
    "POST",
    `/v1/tenants/${t}/presentation-policies/${encodeURIComponent(policy.policyId)}/versions`,
    {
      purpose: spec.purpose,
      credentialRequirements: [
        { credentialType: doc.type.vct, acceptedFormats: ["dc+sd-jwt"] },
      ],
      requestedClaims: spec.requestedClaims.map((p) => ({ path: p })),
      resultPolicy: { kind: "VERIFIED_CLAIMS", allowedClaims: spec.requestedClaims },
      trustPolicy: {
        anchorSources: [
          { kind: "ETSI_TS_119_602_LOTE", domain: "EAA_PROVIDER", ref: trustListUrl },
        ],
        statusCheckMode: "STRICT",
      },
      publish: true,
    },
  );
  process.stdout.write(
    `Intended use          ${use.intendedUseId} (${spec.intendedUseIdentifier})\n` +
      `Presentation policy   ${policy.policyId} v${version.version} (${version.status})\n\n` +
      "Add it to HOSTED_VERIFIER_POLICIES and to DEMO_BANK_POLICIES as fibra=<policyId>.\n",
  );
};

const main = async () => {
  const { tenantId } = await api("GET", "/v1/me");
  const t = encodeURIComponent(tenantId);
  if (command === "issuance") await issuance(t, ...rest);
  else await presentation(t, ...rest);
  process.stdout.write(
    "\nEvery fixed value is FICTITIOUS test data and the source is a FIXTURE. The model is this\n" +
      "project's, not a Rulebook. TEST environment only.\n",
  );
};

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
