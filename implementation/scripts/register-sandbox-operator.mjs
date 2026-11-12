#!/usr/bin/env node
/**
 * Sets up the **sandbox operator's sign-in verifier** (ADR 0015) on a fresh sandbox stack: the
 * Relying Party Instance that signs people into the sandbox with their PID. It is what
 * `docs/sandbox/s2-run-sheet.md` describes as API calls, as two commands with the access certificate
 * between them.
 *
 *   PLATFORM_TENANT_API_KEY=… node scripts/register-sandbox-operator.mjs relying-party
 *
 * 1. The Organisation, the Relying Party and its one Service. Prints the service id.
 *
 * Then, by the existing scripts (infra/sandbox-vm/README.md step 8):
 * - the engine tenant (`scripts/create-engine-tenant.sh sbx-operator`);
 * - an access certificate from the **sandbox** Access CA (`packages/sandbox-pki/dist/cli.js
 *   issue-access`), chain-checked, then imported (`scripts/import-access-certificate.sh`);
 * - the sign-in PID list loaded on that tenant (`scripts/load-issuer-trust-list.mjs`).
 *
 *   PLATFORM_TENANT_API_KEY=… node scripts/register-sandbox-operator.mjs policy \
 *     <relyingPartyServiceId> <signInPidListUrl> <participantPidListUrl>
 *
 * 2. The intended use registering the five sign-in claims, and the published policy:
 *    `DERIVED_CLAIMS` with one `PseudonymousSubject` over them, output `subject`, nothing else
 *    (ADR 0015 Decision 3). Its only anchor source is the sign-in PID list: the reference PID
 *    Providers and "PID (demo)". **Never the sandbox's participant PID list** (ADR 0015 Decision 2):
 *    the script refuses if the two URLs are the same, and the platform refuses to start if the policy
 *    names a participant source.
 *
 * The key is a credential and must not be an argument. TEST only.
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const KEY = process.env.PLATFORM_TENANT_API_KEY;
const [command, ...rest] = process.argv.slice(2);

const USAGE =
  "usage: node scripts/register-sandbox-operator.mjs relying-party\n" +
  "       node scripts/register-sandbox-operator.mjs policy <relyingPartyServiceId> <signInPidListUrl> <participantPidListUrl>\n";

/** ADR 0015 Decision 3, amended: the subject is derived from these five, and only these. */
export const SIGN_IN_CLAIMS = [
  ["given_name"],
  ["family_name"],
  ["birthdate"],
  ["issuing_authority"],
  ["issuing_country"],
];
const VCT = "urn:eudi:pid:1";

if (!KEY) {
  process.stderr.write(
    "Set PLATFORM_TENANT_API_KEY. It is a secret and must not be an argument.\n",
  );
  process.exit(1);
}
if (
  !(command === "relying-party" && rest.length === 0) &&
  !(command === "policy" && rest.length === 3)
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

const relyingParty = async (t) => {
  const organisation = await api("POST", `/v1/tenants/${t}/organisations`, {
    legalName: "EDTP Sandbox operator",
    memberState: "EU",
    isPublicSectorBody: false,
    officialIdentifiers: [{ scheme: "urn:edtp:sandbox:identifier", value: "SB:EU-000000" }],
  });
  const rp = await api("POST", `/v1/tenants/${t}/relying-parties`, {
    organisationId: organisation.organisationId,
    registrarAssignedIdentifier: "SB:EU-000000",
    registrar: "EDTP sandbox registrar (TEST)",
    tradeName: "EDTP Sandbox",
    trustEnvironment: "TEST",
  });
  const service = await api("POST", `/v1/tenants/${t}/rp-services`, {
    relyingPartyId: rp.relyingPartyId,
    serviceIdentifier: "SIGNIN",
    serviceTradeName: "EDTP Sandbox sign-in",
    description: [{ lang: "en", value: "Sign in to the EDTP EUDI ecosystem sandbox" }],
    callbackUrlAllowList: [],
  });
  process.stdout.write(
    `Organisation          ${organisation.organisationId}\n` +
      `Relying Party         ${rp.relyingPartyId}  ${rp.registrarAssignedIdentifier}\n` +
      `Relying Party Service ${service.serviceId}  ${service.serviceTradeName}\n\n` +
      "Next: the engine tenant, a sandbox access certificate, the instance and the sign-in PID list\n" +
      "(infra/sandbox-vm/README.md step 8). Then the `policy` command.\n",
  );
};

const policy = async (t, serviceId, signInList, participantList) => {
  for (const url of [signInList, participantList]) {
    if (!url.startsWith("https://")) throw new Error("both list URLs must be https");
  }
  if (signInList === participantList) {
    throw new Error(
      "the sign-in list must not be the participant PID list: a participant could sign in as anyone (ADR 0015 Decision 2)",
    );
  }
  const purpose = [{ lang: "en", value: "Sign in to the EDTP EUDI ecosystem sandbox" }];
  const use = await api(
    "POST",
    `/v1/tenants/${t}/rp-services/${encodeURIComponent(serviceId)}/intended-uses`,
    {
      intendedUseIdentifier: "edtp-sandbox-sign-in",
      purpose,
      privacyPolicyUris: [{ lang: "en", value: "https://sandbox.murcata.es/" }],
      registeredCredentials: [
        { format: "dc+sd-jwt", vctValues: [VCT], claims: SIGN_IN_CLAIMS },
      ],
    },
  );
  const created = await api("POST", `/v1/tenants/${t}/presentation-policies`, {
    relyingPartyServiceId: serviceId,
    intendedUseId: use.intendedUseId,
    name: "EDTP Sandbox sign-in",
    description:
      "Signs a person into the sandbox: one pseudonymous subject derived from five PID claims, which are then discarded.",
  });
  const version = await api(
    "POST",
    `/v1/tenants/${t}/presentation-policies/${encodeURIComponent(created.policyId)}/versions`,
    {
      purpose,
      credentialRequirements: [{ credentialType: VCT, acceptedFormats: ["dc+sd-jwt"] }],
      requestedClaims: SIGN_IN_CLAIMS.map((path) => ({ path })),
      resultPolicy: {
        kind: "DERIVED_CLAIMS",
        derivations: [
          { name: "PseudonymousSubject", sourcePaths: SIGN_IN_CLAIMS, outputClaim: "subject" },
        ],
      },
      trustPolicy: {
        anchorSources: [
          { kind: "ETSI_TS_119_602_LOTE", domain: "PID_PROVIDER", ref: signInList },
        ],
        statusCheckMode: "STRICT",
      },
      publish: true,
    },
  );
  const { tenantId } = await api("GET", "/v1/me");
  process.stdout.write(
    `Intended use          ${use.intendedUseId}\n` +
      `Presentation policy   ${created.policyId} v${version.version} (${version.status})\n\n` +
      "Add to .env, then recreate platform-api:\n" +
      `  SANDBOX_OPERATOR_TENANT_ID=${tenantId}\n` +
      `  SANDBOX_SIGN_IN_POLICY_ID=${created.policyId}\n`,
  );
};

const main = async () => {
  const { tenantId } = await api("GET", "/v1/me");
  const t = encodeURIComponent(tenantId);
  if (command === "relying-party") await relyingParty(t);
  else await policy(t, ...rest);
  process.stdout.write("\nTEST environment only.\n");
};

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
