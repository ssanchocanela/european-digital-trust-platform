#!/usr/bin/env bash
# End-to-end walkthrough of the Verification-as-a-Service configuration chain and a
# presentation, using nothing but curl.
#
#   PLATFORM_ADMIN_API_KEY=... ./scripts/smoke-vaas.sh
#
# Walks: Tenant -> Organisation -> Relying Party (TEST) -> Service -> Intended Use ->
# registration certificate record -> Relying Party Instance -> Presentation Policy ->
# published version -> POST /v1/presentations -> GET /v1/presentations/{id}.
#
# What it does NOT do: complete a wallet interaction. That needs a wallet, a public HTTPS
# origin and a trusted access certificate — see docs/reference-wallet-testing.md. The script
# stops at the interaction URI and says so, rather than pretending the flow completed.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3100}"
ADMIN_KEY="${PLATFORM_ADMIN_API_KEY:?set PLATFORM_ADMIN_API_KEY}"
ENGINE_TENANT_REF="${ENGINE_TENANT_REF:-root}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required." >&2
  exit 1
fi

note() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

api() {
  local method=$1 path=$2 key=$3 body=${4:-}
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE_URL$path" \
      -H "authorization: Bearer $key" \
      -H 'content-type: application/json' \
      -d "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" -H "authorization: Bearer $key"
  fi
}

note "Health"
api GET /health "$ADMIN_KEY" | jq .

note "1. Create the tenant (the only route the administrative key may use)"
TENANT=$(api POST /v1/tenants "$ADMIN_KEY" '{"name":"Smoke Test Retailer"}')
echo "$TENANT" | jq '{tenantId, name}'
TENANT_ID=$(echo "$TENANT" | jq -r .tenantId)
# Shown once and stored only as a hash.
TENANT_KEY=$(echo "$TENANT" | jq -r .apiKey)

note "2. Register the Organisation"
ORG=$(api POST "/v1/tenants/$TENANT_ID/organisations" "$TENANT_KEY" '{
  "legalName": "Smoke Test Retailer B.V.",
  "memberState": "NL",
  "isPublicSectorBody": false,
  "officialIdentifiers": [
    { "scheme": "http://data.europa.eu/eudi/id/EUID", "value": "NLNHR.12345678" }
  ]
}')
echo "$ORG" | jq .
ORG_ID=$(echo "$ORG" | jq -r .organisationId)

note "3. Register the Relying Party (TEST; the identifier is Registrar-assigned)"
RP=$(api POST "/v1/tenants/$TENANT_ID/relying-parties" "$TENANT_KEY" "$(cat <<JSON
{
  "organisationId": "$ORG_ID",
  "registrarAssignedIdentifier": "NLNHR.12345678",
  "registrar": "NL-Registrar-Sandbox",
  "trustEnvironment": "TEST"
}
JSON
)")
echo "$RP" | jq .
RP_ID=$(echo "$RP" | jq -r .relyingPartyId)

note "4. Register the Relying Party Service"
SVC=$(api POST "/v1/tenants/$TENANT_ID/rp-services" "$TENANT_KEY" "$(cat <<JSON
{
  "relyingPartyId": "$RP_ID",
  "serviceIdentifier": "age-gate",
  "serviceTradeName": "Smoke Test Age Gate",
  "description": [{ "lang": "en", "value": "Age gate for account onboarding" }],
  "callbackUrlAllowList": []
}
JSON
)")
echo "$SVC" | jq '{serviceId, serviceIdentifier, serviceTradeName}'
SVC_ID=$(echo "$SVC" | jq -r .serviceId)

note "5. Register the intended use (purpose and privacy policy are shown to the User)"
USE=$(api POST "/v1/tenants/$TENANT_ID/rp-services/$SVC_ID/intended-uses" "$TENANT_KEY" '{
  "intendedUseIdentifier": "registrar-intended-use-1",
  "purpose": [{ "lang": "en", "value": "Confirm the customer is an adult" }],
  "privacyPolicyUris": [{ "lang": "en", "value": "https://verifier.example/privacy" }],
  "registeredCredentials": [
    {
      "format": "dc+sd-jwt",
      "vctValues": ["urn:eudi:pid:1"],
      "claims": [["birthdate"]]
    }
  ]
}')
echo "$USE" | jq .
USE_ID=$(echo "$USE" | jq -r .intendedUseId)

note "6. Record the registration certificate slot (no JWT available in V0 — blocker B3)"
api POST "/v1/tenants/$TENANT_ID/rp-services/$SVC_ID/registration-certificates" "$TENANT_KEY" "$(cat <<JSON
{ "intendedUseId": "$USE_ID", "trustEnvironment": "TEST" }
JSON
)" | jq .

note "7. Provision the Relying Party Instance and import the access certificate"
echo "Using a development key pair. For a wallet-trusted certificate see"
echo "scripts/import-access-certificate.sh and docs/reference-wallet-testing.md."
DEV_JWK=$(node -e '
const { generateKeyPairSync, createPublicKey } = require("node:crypto");
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.stdout.write(JSON.stringify(privateKey.export({ format: "jwk" })));
')
INSTANCE=$(api POST "/v1/tenants/$TENANT_ID/rp-services/$SVC_ID/instance" "$TENANT_KEY" "$(cat <<JSON
{
  "engineTenantRef": "$ENGINE_TENANT_REF",
  "trustEnvironment": "TEST",
  "accessCertificate": {
    "privateKeyJwk": $DEV_JWK,
    "certificateChain": ["-----BEGIN CERTIFICATE-----\nREPLACE-WITH-A-REAL-ACCESS-CERTIFICATE\n-----END CERTIFICATE-----"],
    "subject": "CN=Smoke Test Age Gate",
    "issuer": "CN=Development Access CA"
  }
}
JSON
)")
echo "$INSTANCE" | jq .

note "8. Create the presentation policy"
POLICY=$(api POST "/v1/tenants/$TENANT_ID/presentation-policies" "$TENANT_KEY" "$(cat <<JSON
{
  "relyingPartyServiceId": "$SVC_ID",
  "intendedUseId": "$USE_ID",
  "name": "Adult verification",
  "description": "Confirms the customer is at least 18 years old."
}
JSON
)")
echo "$POLICY" | jq .
POLICY_ID=$(echo "$POLICY" | jq -r .policyId)

note "9. Publish a policy version"
echo "Requests the date of birth and returns only a boolean. age_over_18 is no longer a PID"
echo "attribute (PID Rulebook v1.1, following CIR 2024/2977), so derivation is the only"
echo "minimising route for an age check — ADR 0005 Decision 5."
api POST "/v1/tenants/$TENANT_ID/presentation-policies/$POLICY_ID/versions" "$TENANT_KEY" '{
  "purpose": [{ "lang": "en", "value": "Confirm the customer is an adult" }],
  "credentialRequirements": [
    { "credentialType": "urn:eudi:pid:1", "acceptedFormats": ["dc+sd-jwt"] }
  ],
  "requestedClaims": [{ "path": ["birthdate"] }],
  "resultPolicy": {
    "kind": "DERIVED_CLAIMS",
    "derivations": [
      {
        "name": "AgeAtLeast",
        "sourcePath": ["birthdate"],
        "minimumAgeYears": 18,
        "outputClaim": "over_18"
      }
    ]
  },
  "publish": true
}' | jq .

note "9b. A policy version that over-asks is refused with 422 and the offending path named"
api POST "/v1/tenants/$TENANT_ID/presentation-policies/$POLICY_ID/versions" "$TENANT_KEY" '{
  "purpose": [{ "lang": "en", "value": "Over-asking on purpose" }],
  "credentialRequirements": [
    { "credentialType": "urn:eudi:pid:1", "acceptedFormats": ["dc+sd-jwt"] }
  ],
  "requestedClaims": [{ "path": ["birthdate"] }, { "path": ["portrait"] }],
  "resultPolicy": { "kind": "VERIFIED_CLAIMS", "allowedClaims": [["birthdate"]] }
}' | jq '{error, details}'

note "10. Create a presentation transaction"
PRESENTATION=$(api POST /v1/presentations "$TENANT_KEY" "$(cat <<JSON
{
  "policyId": "$POLICY_ID",
  "businessReference": "smoke-order-1",
  "interactionType": "SAME_DEVICE"
}
JSON
)")
echo "$PRESENTATION" | jq .
PRESENTATION_ID=$(echo "$PRESENTATION" | jq -r .presentationId)

note "11. Read the transaction"
api GET "/v1/presentations/$PRESENTATION_ID" "$TENANT_KEY" | jq .

note "12. Tenant isolation: the administrative key is refused on a tenant route"
api GET "/v1/tenants/$TENANT_ID" "$ADMIN_KEY" | jq '{error, message}'

cat <<'SUMMARY'

=========================================================================
The configuration chain and the transaction were created successfully.

NOT demonstrated by this script:
  * a wallet interaction. It needs a wallet, a public HTTPS origin, and an access
    certificate whose chain the wallet trusts.
  * an access certificate trusted by an official Reference Implementation build. The
    development key pair above is NOT trusted by any wallet.

Both are blockers B1 and B5 in docs/phase-0-findings.md. docs/reference-wallet-testing.md
has the manual steps.
=========================================================================
SUMMARY
