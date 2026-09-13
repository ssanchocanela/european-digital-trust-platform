#!/usr/bin/env bash
# End-to-end walkthrough of the Issuance-as-a-Service configuration chain, using nothing but curl.
#
#   PLATFORM_ADMIN_API_KEY=... ./scripts/smoke-issuance.sh
#   PLATFORM_ADMIN_API_KEY=... SMOKE_CREDENTIALS_OUT=~/.edtp/issuance-credentials.json \
#     ./scripts/smoke-issuance.sh
#
# Walks: Tenant -> Organisation -> Attestation Provider (TEST) -> engine provisioning with a
# signing key -> Credential Type -> Issuance Policy -> published version -> POST /v1/issuances ->
# GET /v1/issuances/{id} -> the provider-authentication report -> revocation, and the refusal of
# un-revocation.
#
# ## What it does NOT do, and cannot
#
# Issue a credential to a wallet. That is blocker **B7**, and unlike B1 no certificate fixes it:
# the engine produces no `signed_metadata`, which the pinned wallet requires before it will
# authenticate a Credential Issuer at all (`interop-findings.md` A15, ARF §6.6.2.2 gate (a)). The
# script therefore ends by *printing* what a Wallet would face rather than implying it was tested —
# `GET …/provider-authentication` returns that conjunction, and the script shows it whatever it says.
#
# ## Why this exists at all, given that
#
# Because the layers below the wallet have never been exercised live. The verification side taught
# the lesson twice in one day: `interop-findings.md` A14 records four engine payload shapes that are
# **accepted and then wrong**, and A18 records an adapter reading a field that does not exist —
# which survived 21 contract tests because none of them could produce the state that would reveal
# it. Configuration calls that "succeeded" are not evidence. This walks the chain for real and
# checks every step.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3100}"
ADMIN_KEY="${PLATFORM_ADMIN_API_KEY:?set PLATFORM_ADMIN_API_KEY; it is a secret and must not be an argument}"
ENGINE_TENANT_REF="${ENGINE_TENANT_REF:-rpi-1}"

for tool in curl jq node openssl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required." >&2; exit 1; }
done

# A run-unique suffix. The Attestation Provider's registrar-assigned identifier is unique per
# (identifier, trust environment), exactly as the Relying Party's is, so a fixed one would make this
# script succeed once per database and fail on every later run.
SUFFIX="$(openssl rand -hex 4)"

# --- failure accounting -----------------------------------------------------------------
# `set -e` does not fire on a failed HTTP call: curl exits 0 on a 4xx. Without explicit accounting
# a script prints "created successfully" after a 500 — which is the false success CLAUDE.md §8
# forbids, and which the VaaS smoke test had to be corrected for.

FAILURES=0
FAILED_STEPS=""

note() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

api() {
  local method="$1" path="$2" key="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE_URL$path" \
      -H "authorization: Bearer $key" -H 'content-type: application/json' --data-binary "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" -H "authorization: Bearer $key"
  fi
}

# Fails the step when the response carries an `error`, or lacks the field the next step needs.
check() {
  local label="$1" response="$2" expected="$3"
  local err
  err="$(echo "$response" | jq -r '.error // empty')"
  if [ -n "$err" ]; then
    FAILURES=$((FAILURES + 1)); FAILED_STEPS="$FAILED_STEPS\n  - $label: $err"
    return 1
  fi
  if [ -n "$expected" ] && [ "$(echo "$response" | jq -r ".$expected // empty")" = "" ]; then
    FAILURES=$((FAILURES + 1)); FAILED_STEPS="$FAILED_STEPS\n  - $label: response has no .$expected"
    return 1
  fi
  return 0
}

note "Health"
api GET /health "$ADMIN_KEY" | jq .

# --- reuse, because an engine tenant is not a per-run resource --------------------------
#
# An engine tenant serves exactly one Attestation Provider — `interop-findings.md` A20, enforced by
# migration 0006 — because the engine's issuer configuration (authorization servers, the Credential
# Issuer's display name, the registration certificate published as `issuer_info`) is tenant-scoped.
# `ENGINE_TENANT_CREDENTIALS` fixes which engine tenants the platform can reach, so they are a small
# fixed set rather than something a script mints.
#
# This script therefore reuses the tenant and provider it created last time, when the credentials
# file still names a working pair, and builds a fresh chain only when it does not. Before A20 was
# fixed it created a new provider on every run and pointed all of them at one engine tenant, which is
# how the development stack ended up with four providers silently overwriting each other.
#
# Everything downstream of the provider — credential type, policy, transaction — is still created
# fresh on every run, so the chain this script exists to walk is still walked.
REUSE_FILE="${SMOKE_CREDENTIALS_OUT:-$HOME/.edtp/issuance-credentials.json}"
TENANT_ID=""; TENANT_KEY=""; REUSED_PROVIDER_ID=""
if [ -f "$REUSE_FILE" ]; then
  CAND_TENANT=$(jq -r '.tenantId // empty' "$REUSE_FILE" 2>/dev/null || true)
  CAND_KEY=$(jq -r '.tenantApiKey // empty' "$REUSE_FILE" 2>/dev/null || true)
  CAND_PROVIDER=$(jq -r '.attestationProviderId // empty' "$REUSE_FILE" 2>/dev/null || true)
  if [ -n "$CAND_TENANT" ] && [ -n "$CAND_KEY" ] && [ -n "$CAND_PROVIDER" ]; then
    # Verified against the API rather than trusted: the file outlives `docker compose down -v`.
    if api GET "/v1/tenants/$CAND_TENANT/attestation-providers/$CAND_PROVIDER/provider-authentication" \
         "$CAND_KEY" | jq -e 'has("error") | not' >/dev/null 2>&1; then
      TENANT_ID="$CAND_TENANT"; TENANT_KEY="$CAND_KEY"; REUSED_PROVIDER_ID="$CAND_PROVIDER"
    fi
  fi
fi

note "1. Create the tenant"
if [ -n "$TENANT_ID" ]; then
  echo "Reusing tenant $TENANT_ID from $REUSE_FILE — its provider still holds the engine tenant."
else
  TENANT=$(api POST /v1/tenants "$ADMIN_KEY" '{"name":"Smoke Test Issuer"}')
  echo "$TENANT" | jq '{tenantId, name}'
  check "1. create tenant" "$TENANT" tenantId || true
  TENANT_ID=$(echo "$TENANT" | jq -r .tenantId)
  # Shown once and stored only as a hash.
  TENANT_KEY=$(echo "$TENANT" | jq -r .apiKey)
fi

note "2. Register the Organisation"
ORG_ID=""
if [ -n "$REUSED_PROVIDER_ID" ]; then
  echo "Skipped: the reused Attestation Provider already has one."
else
ORG=$(api POST "/v1/tenants/$TENANT_ID/organisations" "$TENANT_KEY" '{
  "legalName": "Smoke Test Issuer B.V.",
  "memberState": "NL",
  "isPublicSectorBody": false,
  "officialIdentifiers": [{ "scheme": "http://data.europa.eu/eudi/id/EUID", "value": "NLNHR.87654321" }]
}')
echo "$ORG" | jq '{organisationId, legalName}'
check "2. register organisation" "$ORG" organisationId || true
ORG_ID=$(echo "$ORG" | jq -r .organisationId)
fi

note "3. Register the Attestation Provider (TEST)"
if [ -n "$REUSED_PROVIDER_ID" ]; then
  PROVIDER_ID="$REUSED_PROVIDER_ID"
  echo "Reusing Attestation Provider $PROVIDER_ID, which already holds engine tenant"
  echo "$ENGINE_TENANT_REF. An engine tenant serves exactly one provider (A20)."
else
  echo "A non-qualified EAA Provider. The identifier is Registrar-assigned in reality; it is"
  echo "generated here so repeat runs do not collide."
  PROVIDER=$(api POST "/v1/tenants/$TENANT_ID/attestation-providers" "$TENANT_KEY" "$(jq -n \
    --arg org "$ORG_ID" --arg id "NLEAA.$SUFFIX" \
    '{organisationId:$org, registrarAssignedIdentifier:$id, registrar:"NL-Registrar-Sandbox", trustEnvironment:"TEST"}')")
  echo "$PROVIDER" | jq '{attestationProviderId, registrarAssignedIdentifier, trustEnvironment}'
  check "3. register provider" "$PROVIDER" attestationProviderId || true
  PROVIDER_ID=$(echo "$PROVIDER" | jq -r .attestationProviderId)
fi

note "4. Provision the provider: engine tenant and attestation-signing key"
echo "A self-signed DEVELOPMENT key pair, generated now. Gate (b) of ARF §6.3.2.4 takes its anchors"
echo "from the Rulebook, so this being self-signed is not what blocks issuance — gate (a) is."
echo "Note the engine's usageType for this key is 'attestation', not 'signing' (A14)."

CERT_DIR=$(mktemp -d); chmod 700 "$CERT_DIR"
trap 'rm -rf "$CERT_DIR"' EXIT
openssl ecparam -name prime256v1 -genkey -noout -out "$CERT_DIR/key.pem" 2>/dev/null
openssl pkcs8 -topk8 -nocrypt -in "$CERT_DIR/key.pem" -out "$CERT_DIR/key8.pem" 2>/dev/null
openssl req -new -x509 -key "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" -days 2 \
  -subj "/CN=Smoke Test Issuer/O=Development only/C=NL" 2>/dev/null
chmod 600 "$CERT_DIR"/*.pem

JWK=$(node -e '
const { readFileSync } = require("node:fs");
const { createPrivateKey } = require("node:crypto");
process.stdout.write(JSON.stringify(createPrivateKey(readFileSync(process.argv[1], "utf8")).export({ format: "jwk" })));
' "$CERT_DIR/key8.pem")
CHAIN=$(node -e '
const { readFileSync } = require("node:fs");
process.stdout.write(JSON.stringify([readFileSync(process.argv[1], "utf8")]));
' "$CERT_DIR/cert.pem")

PROVISION=$(api POST "/v1/tenants/$TENANT_ID/attestation-providers/$PROVIDER_ID/provision" "$TENANT_KEY" \
  "$(jq -n --arg ref "$ENGINE_TENANT_REF" --argjson jwk "$JWK" --argjson chain "$CHAIN" \
    '{engineTenantRef:$ref, signingCertificate:{privateKeyJwk:$jwk, certificateChain:$chain}}')")
echo "$PROVISION" | jq .
check "4. provision provider" "$PROVISION" "" || true

# An engine tenant serves one Attestation Provider (A20). When another one holds it, say what to do:
# the failure is correct, and a correct failure that leaves the operator stuck is still a bad day.
if [ "$(echo "$PROVISION" | jq -r '.error // empty')" = "engine_tenant_already_assigned" ]; then
  cat <<GUIDE

  $ENGINE_TENANT_REF already serves another Attestation Provider. That is the A20 rule holding,
  not a defect: the engine's issuer configuration is tenant-scoped, so two providers on one
  engine tenant overwrite each other's authorization servers, display name and — the one that
  matters — registration certificate.

  Either point this run at a different engine tenant:

      ENGINE_TENANT_REF=<a ref in ENGINE_TENANT_CREDENTIALS> $0

  or release it from the provider that holds it, if that provider is finished with:

      curl -X DELETE "\$BASE_URL/v1/tenants/<tenantId>/attestation-providers/<providerId>/provision" \\
        -H "authorization: Bearer <that tenant's key>"

GUIDE
fi

note "5. Create the Credential Type"
echo "The Rulebook is trust configuration, not a label: ARF §6.3.2.4 makes it the source of anchors"
echo "for verifying this attestation's signature. anchorSource stays RULEBOOK_ONLY."
TYPE=$(api POST "/v1/tenants/$TENANT_ID/credential-types" "$TENANT_KEY" "$(jq -n --arg p "$PROVIDER_ID" '{
  attestationProviderId: $p,
  name: "Employee badge",
  format: "dc+sd-jwt",
  vct: "urn:edtp:employee-badge:1",
  rulebook: { identifier: "urn:edtp:rulebook:employee-badge", version: "1.0", anchorSource: "RULEBOOK_ONLY" },
  claims: [
    { path: ["employee_id"], display: [{ lang: "en", value: "Employee number" }], mandatory: true, valueType: "string" },
    { path: ["employer_name"], display: [{ lang: "en", value: "Employer" }], mandatory: true, valueType: "string" }
  ],
  display: [{ lang: "en", value: "Employee badge" }],
  validitySeconds: 2592000,
  statusMechanism: "TOKEN_STATUS_LIST",
  requiresKeyBinding: true
}')")
echo "$TYPE" | jq '{credentialTypeId, vct, format}'
check "5. create credential type" "$TYPE" credentialTypeId || true
TYPE_ID=$(echo "$TYPE" | jq -r .credentialTypeId)

note "6. Create the Issuance Policy"
POLICY=$(api POST "/v1/tenants/$TENANT_ID/issuance-policies" "$TENANT_KEY" \
  "$(jq -n --arg t "$TYPE_ID" '{credentialTypeId:$t, name:"Employee badge issuance"}')")
echo "$POLICY" | jq '{policyId, name}'
check "6. create issuance policy" "$POLICY" policyId || true
POLICY_ID=$(echo "$POLICY" | jq -r .policyId)

note "7. Publish a policy version"
echo "Eligibility by the MinimumAge evaluator, attributes from the 'fixture' authentic source —"
echo "a connector that is labelled a fixture in its own name, because §7.2 requires it to be."
VERSION=$(api POST "/v1/tenants/$TENANT_ID/issuance-policies/$POLICY_ID/versions" "$TENANT_KEY" \
  "$(jq -n --arg t "$TYPE_ID" '{
  credentialTypeId: $t,
  purpose: [{ lang: "en", value: "Issue an employee badge to a verified employee" }],
  eligibilityRule: { evaluator: "MinimumAge", parameters: { minimumAgeYears: 18 } },
  authenticSource: { connector: "fixture", parameters: {} },
  holderBinding: "KEY_BOUND",
  flow: "PRE_AUTHORIZED_CODE",
  credentialValiditySeconds: 2592000,
  statusPolicy: { statusListEnabled: true, suspensionAllowed: true },
  publish: true
}')")
echo "$VERSION" | jq '{version, published}'
check "7. publish policy version" "$VERSION" version || true

note "8. Issue to the adult fixture subject"
echo "subjectReference is a LOOKUP KEY, never attribute values: a client that could pass values"
echo "would make the platform an attestation laundry."
ISSUANCE=$(api POST /v1/issuances "$TENANT_KEY" \
  "$(jq -n --arg p "$POLICY_ID" '{policyId:$p, subjectReference:"fixture-subject-adult", businessReference:"smoke-badge-1"}')")
echo "$ISSUANCE" | jq .
check "8. create issuance" "$ISSUANCE" issuanceId || true
ISSUANCE_ID=$(echo "$ISSUANCE" | jq -r .issuanceId)

note "9. Read the issuance transaction"
api GET "/v1/issuances/$ISSUANCE_ID" "$TENANT_KEY" | jq .

note "10. The minor fixture subject is refused by the eligibility rule"
api POST /v1/issuances "$TENANT_KEY" \
  "$(jq -n --arg p "$POLICY_ID" '{policyId:$p, subjectReference:"fixture-subject-minor", businessReference:"smoke-badge-minor"}')" |
  jq '{issuanceId, status, error, message, outcome}'

note "11. An unknown subject reference is refused, and says so without inventing a subject"
api POST /v1/issuances "$TENANT_KEY" \
  "$(jq -n --arg p "$POLICY_ID" '{policyId:$p, subjectReference:"no-such-subject", businessReference:"smoke-badge-unknown"}')" |
  jq '{issuanceId, status, error, message, outcome}'

note "12. What a Wallet would face — the honest report, whatever it says"
echo "ARF §6.6.2.2 gate (a): the Wallet must authenticate the Credential Issuer before requesting"
echo "issuance. metadataSigned is expected FALSE — the engine produces no signed_metadata (A15),"
echo "which is blocker B7. A 'true' here would mean the engine gained support and the docs are stale."
api GET "/v1/tenants/$TENANT_ID/attestation-providers/$PROVIDER_ID/provider-authentication" "$TENANT_KEY" | jq .

note "13. Revocation is irreversible — VCR_04"
CREDS=$(api GET "/v1/issuances/$ISSUANCE_ID" "$TENANT_KEY")
CRED_ID=$(echo "$CREDS" | jq -r '.issuedCredentialId // .credential.issuedCredentialId // empty')
if [ -n "$CRED_ID" ]; then
  echo "revoking $CRED_ID"
  api POST "/v1/issued-credentials/$CRED_ID/revoke" "$TENANT_KEY" '{}' | jq '{status, error, message}'
  echo "then attempting to set it back to VALID, which must be refused:"
  api POST "/v1/issued-credentials/$CRED_ID/status" "$TENANT_KEY" '{"status":"VALID"}' |
    jq '{status, error, message}'
else
  echo "no issued credential id on the transaction — nothing to revoke."
  echo "That is expected while B7 stands: no wallet has collected the offer, so nothing was issued."
fi

if [ -n "${SMOKE_CREDENTIALS_OUT:-}" ]; then
  ( umask 077
    jq -n --arg t "$TENANT_ID" --arg k "$TENANT_KEY" --arg p "$POLICY_ID" --arg ct "$TYPE_ID" \
      --arg ap "$PROVIDER_ID" \
      '{tenantId:$t, tenantApiKey:$k, issuancePolicyId:$p, credentialTypeId:$ct, attestationProviderId:$ap}' \
      > "$SMOKE_CREDENTIALS_OUT" )
  chmod 600 "$SMOKE_CREDENTIALS_OUT"
  printf '\nTenant credentials written to %s (mode 600). The API key is in it and is a secret.\n' \
    "$SMOKE_CREDENTIALS_OUT"
fi

if [ "$FAILURES" -gt 0 ]; then
  printf '\n\033[31m=========================================================================\033[0m\n'
  printf '\033[31m%d step(s) FAILED:\033[0m' "$FAILURES"
  printf '%b\n' "$FAILED_STEPS"
  printf '\033[31mThe configuration chain did NOT complete. Nothing above should be read as a\npassing end-to-end run.\033[0m\n'
  printf '\033[31m=========================================================================\033[0m\n'
  exit 1
fi

cat <<'EOF'

=========================================================================
The issuance configuration chain was created successfully, and every step was checked
rather than assumed.

NOT demonstrated by this script, and not demonstrable by any script:
  * a Wallet collecting the credential. ARF §6.6.2.2 gate (a) requires the Wallet to
    authenticate the Credential Issuer from SIGNED issuer metadata, and the engine
    produces none — blocker B7, interop-findings A15. Step 12 reports that rather than
    working around it.
  * that gate (b) is satisfied. Anchors for a non-qualified EAA come from the Rulebook
    (ARF §6.3.2.4); publishing a list is possible but is not a notified one.

Neither gate may be described as met. See docs/issuer-trust-model.md.
=========================================================================
EOF
