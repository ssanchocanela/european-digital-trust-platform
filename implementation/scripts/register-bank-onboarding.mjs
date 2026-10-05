#!/usr/bin/env node
/**
 * Sets up **Banco Horizonte**, the fictitious bank of the onboarding demonstration
 * (`apps/demo-onboarding`): a Relying Party of its own, and the presentation policy its page uses.
 *
 * ## Two commands, with the access certificate between them
 *
 *   PLATFORM_TENANT_API_KEY=… node scripts/register-bank-onboarding.mjs relying-party
 *
 * 1. The Organisation, the Relying Party and its one Service. Prints the service id.
 *
 * Then, by the existing scripts — one engine tenant per Relying Party Instance (ADR 0002 Decision 3):
 *
 *   ./scripts/create-engine-tenant.sh horizonte-1 "Banco Horizonte"
 *   EDTP_LEAF_NAME=horizonte EDTP_LEAF_SUBJECT="/CN=Banco Horizonte - TEST/O=Banco Horizonte S.A. (ficticio)/C=ES" \
 *     ./scripts/make-dev-access-ca.sh <engine-public-hostname>
 *   TENANT_ID=… PLATFORM_TENANT_API_KEY=… \
 *     ./scripts/import-access-certificate.sh <serviceId> horizonte-1 ~/.edtp/dev-access-ca/horizonte.p12
 *
 * The leaf is signed by the development Access CA, which is on the EDTP TEST list a wallet built
 * with WD-3 reads and on no notified list: only a **modified wallet** accepts it (`CLAUDE.md` §8).
 *
 *   PLATFORM_TENANT_API_KEY=… node scripts/register-bank-onboarding.mjs policy \
 *     <relyingPartyServiceId> <pidTrustListUrl>
 *
 * 2. A new intended use registering the PID claims the onboarding asks for, and the published
 *    policy: `VERIFIED_CLAIMS`, those claims and no others. The issuer anchor is the TEST list of
 *    PID providers, which must carry the test PID provider's certificate.
 *
 * ## What the definition is
 *
 * `scripts/onboarding/bank-onboarding.json`. The bank is fictitious and so is every identifier: no
 * Registrar assigned them, and no registration certificate exists (blocker B3). `TEST` only.
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
  "usage: node scripts/register-bank-onboarding.mjs relying-party\n" +
  "       node scripts/register-bank-onboarding.mjs policy <relyingPartyServiceId> <pidTrustListUrl>\n";

if (!KEY) {
  process.stderr.write(
    "Set PLATFORM_TENANT_API_KEY. It is a secret and must not be an argument.\n",
  );
  process.exit(1);
}
if (
  !(command === "relying-party" && rest.length === 0) &&
  !(command === "policy" && rest.length === 2)
) {
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

const doc = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "onboarding", "bank-onboarding.json"),
    "utf8",
  ),
);

const relyingParty = async (t) => {
  const organisation = await api("POST", `/v1/tenants/${t}/organisations`, doc.organisation);
  const rp = await api("POST", `/v1/tenants/${t}/relying-parties`, {
    organisationId: organisation.organisationId,
    ...doc.relyingParty,
  });
  const service = await api("POST", `/v1/tenants/${t}/rp-services`, {
    relyingPartyId: rp.relyingPartyId,
    ...doc.service,
  });
  // The response also carries the webhook secret, shown once. The demonstration page polls and
  // registers no callback, so the secret is deliberately not printed.
  process.stdout.write(
    `Organisation          ${organisation.organisationId}\n` +
      `Relying Party         ${rp.relyingPartyId}  ${rp.registrarAssignedIdentifier}\n` +
      `Relying Party Service ${service.serviceId}  ${service.serviceTradeName}\n\n` +
      "Next: an engine tenant, an access certificate from the development Access CA, and the\n" +
      "instance — the three commands in this script's header. Then the `policy` command.\n",
  );
};

const policy = async (t, serviceId, trustListUrl) => {
  if (!trustListUrl.startsWith("https://")) throw new Error("the trust list URL must be https");
  const spec = doc.policy;
  const use = await api(
    "POST",
    `/v1/tenants/${t}/rp-services/${encodeURIComponent(serviceId)}/intended-uses`,
    {
      ...doc.intendedUse,
      registeredCredentials: [
        { format: "dc+sd-jwt", vctValues: [doc.vct], claims: spec.requestedClaims },
      ],
    },
  );
  const created = await api("POST", `/v1/tenants/${t}/presentation-policies`, {
    relyingPartyServiceId: serviceId,
    intendedUseId: use.intendedUseId,
    name: spec.name,
    description: spec.description,
  });
  const version = await api(
    "POST",
    `/v1/tenants/${t}/presentation-policies/${encodeURIComponent(created.policyId)}/versions`,
    {
      purpose: doc.intendedUse.purpose,
      credentialRequirements: [{ credentialType: doc.vct, acceptedFormats: ["dc+sd-jwt"] }],
      requestedClaims: spec.requestedClaims.map((p) => ({ path: p })),
      resultPolicy: { kind: "VERIFIED_CLAIMS", allowedClaims: spec.requestedClaims },
      // Stated: a policy that names no anchors is refused at the first presentation
      // (`trust_anchor_sources_missing`, interop-findings.md A30).
      trustPolicy: {
        anchorSources: [
          { kind: "ETSI_TS_119_602_LOTE", domain: "PID_PROVIDER", ref: trustListUrl },
        ],
        statusCheckMode: "STRICT",
      },
      publish: true,
    },
  );
  process.stdout.write(
    `Intended use          ${use.intendedUseId} (${doc.intendedUse.intendedUseIdentifier})\n` +
      `Presentation policy   ${created.policyId} v${version.version} (${version.status})\n\n` +
      "Add to .env:\n" +
      `  HOSTED_VERIFIER_POLICIES     …,<tenantId>:${created.policyId}\n` +
      `  HOSTED_VERIFIER_ORIGINS      ${created.policyId}=https://<onboarding-host>\n` +
      `  HOSTED_VERIFIER_QR_POLICIES  ${created.policyId}\n` +
      `  ONBOARDING_POLICY            ${created.policyId}\n`,
  );
};

const main = async () => {
  const { tenantId } = await api("GET", "/v1/me");
  const t = encodeURIComponent(tenantId);
  if (command === "relying-party") await relyingParty(t);
  else await policy(t, ...rest);
  process.stdout.write(
    "\nBanco Horizonte is FICTITIOUS and every identifier is a TEST placeholder. TEST environment only.\n",
  );
};

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
