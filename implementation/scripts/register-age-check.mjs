#!/usr/bin/env node
/**
 * Registers the public age check of the demonstration portal: "over 18", derived from the PID's date of
 * birth. The date itself is never returned (ADR 0005 Decision 5; CLAUDE.md §6.1: `age_over_18` does not
 * exist in the PID).
 *
 * It copies the service, the intended use, the credential requirement and the trust anchors from an
 * existing PID presentation policy (the identification policy), and asks for `birthdate` only.
 *
 *   PLATFORM_TENANT_API_KEY=… node scripts/register-age-check.mjs <identificationPresentationPolicyId>
 *
 * Prints the new policy id, for HOSTED_VERIFIER_POLICIES and DEMO_BANK_POLICIES (`edad=`).
 */
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const KEY = process.env.PLATFORM_TENANT_API_KEY;
const [fromPolicyId] = process.argv.slice(2);
if (!KEY || !fromPolicyId) {
  process.stderr.write(
    "usage: PLATFORM_TENANT_API_KEY=… node scripts/register-age-check.mjs <identificationPolicyId>\n",
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
    throw new Error(
      `${method} ${path} → ${response.status} ${parsed.message ?? text} ${JSON.stringify(parsed.details ?? "")}`,
    );
  }
  return parsed;
};
const { tenantId } = await api("GET", "/v1/me");
const t = encodeURIComponent(tenantId);
const from = await api(
  "GET",
  `/v1/tenants/${t}/presentation-policies/${encodeURIComponent(fromPolicyId)}`,
);
const latest = [...from.versions]
  .filter((v) => v.status === "PUBLISHED")
  .sort((a, b) => b.version - a.version)[0];
if (!latest) throw new Error(`Policy ${fromPolicyId} has no published version.`);
const policy = await api("POST", `/v1/tenants/${t}/presentation-policies`, {
  relyingPartyServiceId: from.relyingPartyServiceId,
  intendedUseId: from.intendedUseId,
  name: "Comprobación de mayoría de edad (demo)",
  description:
    "Public demonstration: proves 'over 18' from the PID's date of birth. The date is never returned.",
});
const version = await api(
  "POST",
  `/v1/tenants/${t}/presentation-policies/${encodeURIComponent(policy.policyId)}/versions`,
  {
    purpose: [
      {
        lang: "es",
        value: "Comprobar que es mayor de edad, sin conocer su fecha de nacimiento",
      },
      { lang: "en", value: "Check that you are over 18, without learning your date of birth" },
    ],
    credentialRequirements: latest.credentialRequirements,
    requestedClaims: [{ path: ["birthdate"] }],
    resultPolicy: {
      kind: "DERIVED_CLAIMS",
      derivations: [
        {
          name: "AgeAtLeast",
          sourcePath: ["birthdate"],
          outputClaim: "over_18",
          minimumAgeYears: 18,
        },
      ],
    },
    trustPolicy: latest.trustPolicy,
    publish: true,
  },
);
process.stdout.write(`${policy.policyId} v${version.version}\n`);
