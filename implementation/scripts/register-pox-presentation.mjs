#!/usr/bin/env node
/**
 * Creates the presentation policies that verify a Power of X `:2` attestation.
 *
 * One published policy per attestation type, on a Relying Party Service and under an intended use
 * that registers the `:2` types (`register-credential-catalogue.mjs` with the `:2` catalogue). Each
 * asks for the company, the proxy's type and name, and what the attestation grants — and names the
 * EDTP TEST list of non-qualified EAA providers as its issuer trust anchor, because since A30 a
 * policy that names none is refused rather than verified without checking who signed.
 *
 * ## Where the definitions come from
 *
 * Not from this repository: the claim paths are the Rulebook's attribute identifiers, and that
 * Rulebook's content stays outside it (`docs/credential-catalogue.md`). They are read from
 *
 *     EDTP_POX_PRESENTATION=~/.edtp/credential-catalogue/pox-presentation-policies.json
 *
 * **Only claims every issued attestation carries may be requested.** A DCQL query naming a claim
 * the credential lacks matches no credential, and the wallet reports that it holds nothing
 * suitable — a failure that looks like a wallet problem.
 *
 * ## Usage
 *
 *   PLATFORM_TENANT_API_KEY=… node scripts/register-pox-presentation.mjs \
 *     <relyingPartyServiceId> <intendedUseId>
 *
 * The key is a credential and must not be an argument. `TEST` environment only.
 */

import { existsSync, readFileSync } from "node:fs";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const KEY = process.env.PLATFORM_TENANT_API_KEY;
const [serviceId, intendedUseId] = process.argv.slice(2);

if (!KEY) {
  process.stderr.write(
    "Set PLATFORM_TENANT_API_KEY. It is a secret and must not be an argument.\n",
  );
  process.exit(1);
}
if (!serviceId || !intendedUseId) {
  process.stderr.write(
    "usage: node scripts/register-pox-presentation.mjs <relyingPartyServiceId> <intendedUseId>\n",
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

const main = async () => {
  const path =
    process.env.EDTP_POX_PRESENTATION ??
    `${process.env.HOME}/.edtp/credential-catalogue/pox-presentation-policies.json`;
  if (!existsSync(path)) {
    throw new Error(
      `No Power of X presentation definitions at ${path}. They derive from a Rulebook whose ` +
        "content stays outside this repository; supply the file, or set EDTP_POX_PRESENTATION.",
    );
  }
  const { policies } = JSON.parse(readFileSync(path, "utf8"));
  const { tenantId } = await api("GET", "/v1/me");
  const t = encodeURIComponent(tenantId);

  for (const spec of policies) {
    const policy = await api("POST", `/v1/tenants/${t}/presentation-policies`, {
      relyingPartyServiceId: serviceId,
      intendedUseId,
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
          { credentialType: spec.credentialType, acceptedFormats: ["dc+sd-jwt"] },
        ],
        requestedClaims: spec.requestedClaims.map((p) => ({ path: p })),
        resultPolicy: { kind: "VERIFIED_CLAIMS", allowedClaims: spec.requestedClaims },
        trustPolicy: { anchorSources: spec.anchorSources, statusCheckMode: "STRICT" },
        publish: true,
      },
    );
    process.stdout.write(
      `  ${spec.name.padEnd(36)} ${policy.policyId} v${version.version} (${version.status})\n`,
    );
  }

  process.stdout.write(
    `\nDefinitions loaded from ${path}. The claim paths are this project's interpretation of the\n` +
      "Rulebook; the issuer anchor is a TEST list that is not notified. TEST environment only.\n",
  );
};

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
