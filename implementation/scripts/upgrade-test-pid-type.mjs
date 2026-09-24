#!/usr/bin/env node
/**
 * Moves the test PID to the full PID Rulebook data model: a new credential type from
 * `scripts/pid/pid-rulebook-sd-jwt.json`, and a new version of the PID issuance policy that uses it.
 *
 * ## What changes, and what does not
 *
 * The type carries every attribute and metadata item of the PID Rulebook v1.1 in its SD-JWT VC
 * encoding (section 4.1), except the portrait, with a payload schema for the encoding rules the
 * claim list cannot express: alpha-2 codes, dates, the `sex` code list, and "at least one of country,
 * region or locality" for the place of birth. Credential types are immutable, so this is a new type;
 * the policy gets a new version that points at it.
 *
 * The new version copies a version **named on the command line** — never inferred from list order,
 * because the API lists versions newest first — and changes only the type and the fixed claims,
 * adding `attestation_legal_category: "PID"` and, if given, `trust_anchor`. Everything else, including
 * the reuse policy, is carried over. It is then provisioned, which withdraws the earlier versions from
 * the issuer's metadata.
 *
 * Synthetic data only, `TEST` only. It is not a PID in any sense the Regulation gives the word
 * (`setup-test-pid-issuer.sh` says why).
 *
 * ## Usage
 *
 *   PLATFORM_TENANT_API_KEY=… node scripts/upgrade-test-pid-type.mjs \
 *     <issuancePolicyId> <fromVersion> [--name <type name>] [--display <wallet label>] \
 *     [--trust-anchor <https url>]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const KEY = process.env.PLATFORM_TENANT_API_KEY;
const HERE = dirname(fileURLToPath(import.meta.url));
const RULEBOOK_COMMIT = "36f8adcf914ac06cac18d685add04e0a8a06d685";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const [policyId, fromVersionRaw] = args.filter(
  (a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"),
);
const fromVersion = Number(fromVersionRaw);
const typeName = option("--name") ?? "PID (Rulebook v1.1, synthetic, TEST ONLY)";
const walletLabel = option("--display");
const trustAnchor = option("--trust-anchor");

const die = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
if (!KEY) die("Set PLATFORM_TENANT_API_KEY. It is a secret and must not be an argument.");
if (!policyId || !Number.isInteger(fromVersion) || fromVersion < 1) {
  die(
    "usage: node scripts/upgrade-test-pid-type.mjs <issuancePolicyId> <fromVersion> [options]",
  );
}
if (trustAnchor && !trustAnchor.startsWith("https://")) die("--trust-anchor must be https.");

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

const main = async () => {
  const model = JSON.parse(readFileSync(join(HERE, "pid", "pid-rulebook-sd-jwt.json"), "utf8"));
  const { tenantId } = await api("GET", "/v1/me");
  const t = encodeURIComponent(tenantId);

  const policy = await api(
    "GET",
    `/v1/tenants/${t}/issuance-policies/${encodeURIComponent(policyId)}`,
  );
  const from = policy.versions.find((v) => v.version === fromVersion);
  if (!from) die(`Policy ${policyId} has no version ${fromVersion}.`);
  const previousType = await api(
    "GET",
    `/v1/tenants/${t}/credential-types/${encodeURIComponent(from.credentialTypeId)}`,
  );

  const created = await api("POST", `/v1/tenants/${t}/credential-types`, {
    attestationProviderId: previousType.attestationProviderId,
    name: typeName,
    format: "dc+sd-jwt",
    vct: model.vct,
    rulebook: {
      identifier: "urn:eudi:rulebook:pid",
      version: `1.1 (catalog commit ${RULEBOOK_COMMIT.slice(0, 7)})`,
      publicationUri: `https://github.com/eu-digital-identity-wallet/eudi-doc-attestation-rulebooks-catalog/blob/${RULEBOOK_COMMIT}/rulebooks/pid/pid-rulebook.md`,
      anchorSource: previousType.rulebook.anchorSource,
    },
    claims: model.claims.map((c) => ({
      path: c.path,
      display: [
        { lang: "en", value: c.en },
        { lang: "es", value: c.es },
      ],
      mandatory: c.mandatory,
      valueType: c.valueType,
    })),
    // The wallet's row label: kept from the previous type unless given.
    display: walletLabel
      ? [
          { lang: "en", value: walletLabel },
          { lang: "es", value: walletLabel },
        ]
      : previousType.display,
    validitySeconds: previousType.validitySeconds,
    statusMechanism: previousType.statusMechanism,
    requiresKeyBinding: previousType.requiresKeyBinding,
    payloadSchema: model.payloadSchema,
  });

  const fixedClaims = {
    ...(from.authenticSource.parameters?.fixedClaims ?? {}),
    attestation_legal_category: "PID",
    ...(trustAnchor ? { trust_anchor: trustAnchor } : {}),
  };
  const version = await api(
    "POST",
    `/v1/tenants/${t}/issuance-policies/${encodeURIComponent(policyId)}/versions`,
    {
      credentialTypeId: created.credentialTypeId,
      purpose: from.purpose,
      eligibilityRule: from.eligibilityRule,
      authenticSource: {
        ...from.authenticSource,
        parameters: { ...from.authenticSource.parameters, fixedClaims },
      },
      holderBinding: from.holderBinding,
      flow: from.flow,
      credentialValiditySeconds: from.credentialValiditySeconds,
      statusPolicy: from.statusPolicy,
      retentionPolicy: from.retentionPolicy,
      ...(from.reusePolicy ? { reusePolicy: from.reusePolicy } : {}),
      ...(from.eligibilityPresentationPolicyId
        ? { eligibilityPresentationPolicyId: from.eligibilityPresentationPolicyId }
        : {}),
      publish: true,
    },
  );
  const provisioned = await api(
    "POST",
    `/v1/tenants/${t}/issuance-policies/${encodeURIComponent(policyId)}/provision`,
  );

  process.stdout.write(
    `Credential type ${created.credentialTypeId} (${model.claims.length} claims, payload schema)\n` +
      `Policy ${policyId}: v${version.version} from v${fromVersion}, provisioned; ` +
      `withdrew ${JSON.stringify(provisioned.withdrawn)}\n` +
      "Synthetic data only. TEST environment only.\n",
  );
};

main().catch((error) => die(error.message));
