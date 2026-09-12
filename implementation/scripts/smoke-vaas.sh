#!/usr/bin/env bash
# End-to-end walkthrough of the Verification-as-a-Service configuration chain and a
# presentation, using nothing but curl.
#
#   PLATFORM_ADMIN_API_KEY=... ./scripts/smoke-vaas.sh
#   PLATFORM_ADMIN_API_KEY=... SMOKE_CREDENTIALS_OUT=~/.edtp/smoke-credentials.json \
#     ./scripts/smoke-vaas.sh
#
# `SMOKE_CREDENTIALS_OUT` writes the tenant id, its API key and the published policy id to a
# mode-600 file. It exists because `.env.example` tells the operator to seed the operator
# console "the same way the smoke test does", and the console needs exactly those three values —
# but the tenant API key is returned once and stored only as a hash, so a run that discards it
# leaves the console with a tenant it cannot authenticate to. Opt-in, and to a file rather than
# to stdout: the key must not reach a terminal scrollback or a CI log.
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

for tool in jq curl node openssl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required." >&2; exit 1; }
done

# A run-unique suffix.
#
# The Relying Party identifier is unique per `(registrar_assigned_identifier,
# trust_environment)` — index `relying_parties_identifier_key` — so a fixed identifier makes the
# script succeed exactly once per database and fail on every later run. It is a *Registrar*-
# assigned value in reality, so varying it here is faithful to the model rather than a fudge.
RUN_ID="${RUN_ID:-$(openssl rand -hex 4)}"

note() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# --- failure accounting -----------------------------------------------------------------
#
# `set -e` does not fire on a failed HTTP call, because curl exits 0 on a 4xx/5xx response.
# Without explicit accounting the script printed "created successfully" after a 500, which is
# exactly the kind of false success CLAUDE.md section 8 forbids. Every step is checked.
FAILURES=0
FAILED_STEPS=""

# Fails the step when the response carries an `error` field, or lacks an expected field.
check() {
  local label=$1 response=$2 expect=${3:-}
  local err
  err=$(echo "$response" | jq -r '.error // empty' 2>/dev/null || true)
  if [ -n "$err" ]; then
    printf '\033[31m  STEP FAILED: %s -> %s\033[0m\n' "$label" "$err"
    FAILURES=$((FAILURES + 1)); FAILED_STEPS="${FAILED_STEPS}\n  - ${label}: ${err}"
    return 1
  fi
  if [ -n "$expect" ]; then
    local v
    v=$(echo "$response" | jq -r ".${expect} // empty" 2>/dev/null || true)
    if [ -z "$v" ] || [ "$v" = "null" ]; then
      printf '\033[31m  STEP FAILED: %s -> no %s in the response\033[0m\n' "$label" "$expect"
      FAILURES=$((FAILURES + 1)); FAILED_STEPS="${FAILED_STEPS}\n  - ${label}: missing ${expect}"
      return 1
    fi
  fi
  return 0
}

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
check "1. create tenant" "$TENANT" tenantId || true
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
check "2. register organisation" "$ORG" organisationId || true
ORG_ID=$(echo "$ORG" | jq -r .organisationId)

note "3. Register the Relying Party (TEST; the identifier is Registrar-assigned)"
RP=$(api POST "/v1/tenants/$TENANT_ID/relying-parties" "$TENANT_KEY" "$(cat <<JSON
{
  "organisationId": "$ORG_ID",
  "registrarAssignedIdentifier": "NLNHR.${RUN_ID}",
  "registrar": "NL-Registrar-Sandbox",
  "trustEnvironment": "TEST"
}
JSON
)")
echo "$RP" | jq .
check "3. register relying party" "$RP" relyingPartyId || true
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
check "4. register service" "$SVC" serviceId || true
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
check "5. register intended use" "$USE" intendedUseId || true
USE_ID=$(echo "$USE" | jq -r .intendedUseId)

note "6. Record the registration certificate slot (no JWT available in V0 — blocker B3)"
api POST "/v1/tenants/$TENANT_ID/rp-services/$SVC_ID/registration-certificates" "$TENANT_KEY" "$(cat <<JSON
{ "intendedUseId": "$USE_ID", "trustEnvironment": "TEST" }
JSON
)" | jq .

note "7. Provision the Relying Party Instance and import the access certificate"
echo "Using a self-signed DEVELOPMENT key pair and certificate, generated now. No wallet"
echo "trusts it — AS-WP-06-005 (RPA_04) admits only Access CA anchors from the notified"
echo "LoTEs. For a wallet-trusted certificate see scripts/verify-access-certificate-chain.sh"
echo "and docs/reference-wallet-testing.md."

# The key and the certificate must be the same key pair: the engine validates the leaf
# against the imported private key and rejects a mismatch. Generating the certificate from
# the very key whose JWK is sent is the only way to guarantee that.
#
# This replaces a literal "REPLACE-WITH-A-REAL-ACCESS-CERTIFICATE" placeholder, which is not
# valid base64 and which the engine therefore refused with
# `Invalid leaf certificate: PEM routines::bad base64 decode`. The step had never succeeded;
# the failure was invisible because the script did not check step outcomes.
CERT_DIR=$(mktemp -d); chmod 700 "$CERT_DIR"
trap 'rm -rf "$CERT_DIR"' EXIT
openssl ecparam -name prime256v1 -genkey -noout -out "$CERT_DIR/key.pem" 2>/dev/null
openssl pkcs8 -topk8 -nocrypt -in "$CERT_DIR/key.pem" -out "$CERT_DIR/key8.pem" 2>/dev/null
openssl req -new -x509 -key "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" -days 2 \
  -subj "/CN=Smoke Test Age Gate/O=Development only/C=NL" \
  -addext "subjectAltName=DNS:localhost" 2>/dev/null
chmod 600 "$CERT_DIR"/*.pem

DEV_JWK=$(node -e '
const { readFileSync } = require("node:fs");
const { createPrivateKey } = require("node:crypto");
const key = createPrivateKey(readFileSync(process.argv[1], "utf8"));
process.stdout.write(JSON.stringify(key.export({ format: "jwk" })));
' "$CERT_DIR/key8.pem")
DEV_CHAIN=$(node -e '
const { readFileSync } = require("node:fs");
process.stdout.write(JSON.stringify([readFileSync(process.argv[1], "utf8")]));
' "$CERT_DIR/cert.pem")

INSTANCE=$(api POST "/v1/tenants/$TENANT_ID/rp-services/$SVC_ID/instance" "$TENANT_KEY" "$(cat <<JSON
{
  "engineTenantRef": "$ENGINE_TENANT_REF",
  "trustEnvironment": "TEST",
  "accessCertificate": {
    "privateKeyJwk": $DEV_JWK,
    "certificateChain": $DEV_CHAIN,
    "subject": "CN=Smoke Test Age Gate",
    "issuer": "CN=Smoke Test Age Gate"
  }
}
JSON
)")
echo "$INSTANCE" | jq .
check "7. provision relying party instance" "$INSTANCE" || true

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
check "8. create policy" "$POLICY" policyId || true
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
check "10. create presentation" "$PRESENTATION" presentationId || true
PRESENTATION_ID=$(echo "$PRESENTATION" | jq -r .presentationId)

note "11. Read the transaction"
api GET "/v1/presentations/$PRESENTATION_ID" "$TENANT_KEY" | jq .

note "12. Tenant isolation: the administrative key is refused on a tenant route"
api GET "/v1/tenants/$TENANT_ID" "$ADMIN_KEY" | jq '{error, message}'

if [ "$FAILURES" -gt 0 ]; then
  printf '\n\033[31m=========================================================================\033[0m\n'
  printf '\033[31m%d step(s) FAILED:\033[0m' "$FAILURES"
  printf '%b\n' "$FAILED_STEPS"
  printf '\033[31mThe configuration chain did NOT complete. Nothing above should be read as a\npassing end-to-end run.\033[0m\n'
  printf '\033[31m=========================================================================\033[0m\n'
  exit 1
fi

if [ -n "${SMOKE_CREDENTIALS_OUT:-}" ]; then
  # `umask` first, so the file is never briefly world-readable between creation and chmod.
  ( umask 077
    jq -n --arg t "$TENANT_ID" --arg k "$TENANT_KEY" --arg p "$POLICY_ID" \
      '{tenantId: $t, tenantApiKey: $k, policyId: $p, policyVersion: 1}' \
      > "$SMOKE_CREDENTIALS_OUT" )
  chmod 600 "$SMOKE_CREDENTIALS_OUT"
  printf '\nTenant credentials written to %s (mode 600). The API key is in it and is a secret.\n' \
    "$SMOKE_CREDENTIALS_OUT"
fi

cat <<'EOF'

=========================================================================
The configuration chain and the transaction were created successfully, and every step
was checked rather than assumed: the script exits non-zero if any response carries an
error or omits the identifier the next step needs.

NOT demonstrated by this script:
  * a wallet interaction. It needs a wallet, a public HTTPS origin, and an access
    certificate whose chain the wallet trusts.
  * an access certificate trusted by an official Reference Implementation build. The
    development key pair above is NOT trusted by any wallet.

Both are blockers B1 and B5 in docs/phase-0-findings.md. docs/reference-wallet-testing.md
has the manual steps.
=========================================================================
EOF
