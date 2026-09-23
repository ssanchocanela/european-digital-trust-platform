#!/usr/bin/env bash
# Sets up the test PID issuer: an Attestation Provider on its own engine tenant, signing under the
# development PID Provider CA, a PID credential type, and a published issuance policy whose
# authentic source is the operator's form.
#
#   PLATFORM_TENANT_API_KEY=… ./scripts/setup-test-pid-issuer.sh
#
# Prerequisites, each done once:
#   ./scripts/make-dev-pid-ca.sh                              the CA
#   ./scripts/create-engine-tenant.sh pid-1 "EDTP test PID Provider"
#   docker compose up -d --force-recreate platform-api        so the API sees pid-1
#   ENGINE_TENANT_REF=pid-1 ./scripts/setup-wallet-provider-trust.sh   wallet attestation on pid-1
#
# ## What this issues, and what it must never be called
#
# A **PID-shaped attestation of synthetic data**, signed under a CA that no Member State notified. It
# is not a PID in any sense the Regulation gives the word: PID Provider anchors come from a notified
# list (`EW-PIO-01-024`, `OIA_12`; PID Rulebook §6), and ours is on none. Only a wallet built with
# deviation WD-4 trusts it, and only a verifier given the TEST PID list accepts it. Everything it
# issues carries the fixture warning, because its "authentic source" is a person typing into a form.
#
# ## The credential type, from the Rulebook rather than from memory
#
# SD-JWT VC encoding, PID Rulebook §4.1 at `eudi-doc-attestation-rulebooks-catalog` commit
# `36f8adcf914ac06cac18d685add04e0a8a06d685` (change log to v1.7), `vct` `urn:eudi:pid:1` (`PID_14`).
# Every attribute the Rulebook makes mandatory, and nothing else but birth locality:
#
#   family_name, given_name, birthdate             §2.2, OIDC names
#   place_of_birth.country (+ .locality optional)  §2.2 birth_place: "at least one of country, region
#                                                  or locality". Country is required here, which is
#                                                  stricter than the Rulebook, never looser.
#   nationalities                                  §2.2, an array of alpha-2 codes
#   issuing_authority, issuing_country             §2.4 mandatory metadata, fixed by the policy
#
# `portrait` is omitted: not yet mandatory (§2.2, 24 months after the amending act), and
# `AS-RP-03-01` (`PID_03a`) restricts its retention.
#
# Idempotent: the ids are kept in ~/.edtp/test-pid-issuer.json (mode 600) and reused while the API
# still knows them.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3100}"
KEY="${PLATFORM_TENANT_API_KEY:?set PLATFORM_TENANT_API_KEY; it is a secret and must not be an argument}"
ENGINE_TENANT_REF="${ENGINE_TENANT_REF:-pid-1}"
PID_CA_DIR="${EDTP_DEV_PID_CA_DIR:-$HOME/.edtp/dev-pid-ca}"
STATE="${EDTP_TEST_PID_ISSUER_STATE:-$HOME/.edtp/test-pid-issuer.json}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULEBOOK_COMMIT="36f8adcf914ac06cac18d685add04e0a8a06d685"

for tool in curl jq openssl node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required." >&2; exit 1; }
done
[ -f "$PID_CA_DIR/ca.crt" ] || { echo "No PID CA in $PID_CA_DIR. Run scripts/make-dev-pid-ca.sh." >&2; exit 1; }

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE_URL$path" -H "authorization: Bearer $KEY" \
      -H 'content-type: application/json' --data-binary "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" -H "authorization: Bearer $KEY"
  fi
}
need() { # <label> <json> <field>
  local value; value="$(echo "$2" | jq -r ".$3 // empty")"
  if [ -z "$value" ]; then
    echo "$1 FAILED:" >&2; echo "$2" | jq '{error, message, details}' >&2; exit 1
  fi
  printf '%s' "$value"
}
remember() { # <key> <value>
  local current='{}'; [ -f "$STATE" ] && current="$(cat "$STATE")"
  ( umask 077; echo "$current" | jq --arg k "$1" --arg v "$2" '.[$k] = $v' > "$STATE.tmp" )
  mv "$STATE.tmp" "$STATE"
}
recall() { [ -f "$STATE" ] && jq -r --arg k "$1" '.[$k] // empty' "$STATE" || true; }

TENANT_ID="$(need "Identify the tenant" "$(api GET /v1/me)" tenantId)"
T="/v1/tenants/$TENANT_ID"
echo "==> Tenant $TENANT_ID, engine tenant $ENGINE_TENANT_REF"

# --- Organisation and Attestation Provider ---------------------------------------------------------
PROVIDER_ID="$(recall attestationProviderId)"
PROVIDER_STATE="absent"
if [ -n "$PROVIDER_ID" ]; then
  case "$(api GET "$T/attestation-providers/$PROVIDER_ID/provider-authentication" | jq -r '.error // "ok"')" in
    ok) PROVIDER_STATE="ready" ;;
    # Registered, but the provisioning step did not complete last time: finish it, do not re-register.
    attestation_provider_not_provisioned) PROVIDER_STATE="registered" ;;
  esac
fi

if [ "$PROVIDER_STATE" = "absent" ]; then
  echo "==> Organisation"
  ORG_ID="$(need "Register the organisation" "$(api POST "$T/organisations" '{
    "legalName": "EDTP Test PID Provider - TEST ONLY, not a Member State PID Provider",
    "memberState": "ES",
    "isPublicSectorBody": false,
    "officialIdentifiers": [{ "scheme": "http://data.europa.eu/eudi/id/EUID", "value": "ESTEST.EDTPPID1" }]
  }')" organisationId)"

  echo "==> Attestation Provider (TEST)"
  PROVIDER_ID="$(need "Register the provider" "$(api POST "$T/attestation-providers" "$(jq -n \
    --arg org "$ORG_ID" \
    '{organisationId:$org, registrarAssignedIdentifier:"ESTEST.EDTP-PID-PROVIDER-1",
      registrar:"none - TEST, no Registrar involved", trustEnvironment:"TEST"}')")" attestationProviderId)"
  remember attestationProviderId "$PROVIDER_ID"
  PROVIDER_STATE="registered"
fi

if [ "$PROVIDER_STATE" = "registered" ]; then
  echo "==> Signing certificate under the development PID CA, on $ENGINE_TENANT_REF"
  SIGNING_CA_DIR="$PID_CA_DIR" ENGINE_TENANT_REF="$ENGINE_TENANT_REF" PLATFORM_TENANT_API_KEY="$KEY" \
    BASE_URL="$BASE_URL" CERT_DAYS="${CERT_DAYS:-365}" \
    CERT_SUBJECT="/CN=EDTP Test PID Provider signing - TEST ONLY/O=EDTP development/C=ES" \
    "$HERE/rotate-attestation-key.sh" "$PROVIDER_ID"
else
  echo "==> Reusing Attestation Provider $PROVIDER_ID"
fi

# --- Credential type -------------------------------------------------------------------------------
TYPE_ID="$(recall credentialTypeId)"
if [ -z "$TYPE_ID" ]; then
  echo "==> PID credential type"
  claim() { # <path json> <en> <es> <mandatory> <valueType>
    jq -n --argjson p "$1" --arg en "$2" --arg es "$3" --argjson m "$4" --arg t "$5" \
      '{path:$p, display:[{lang:"en",value:$en},{lang:"es",value:$es}], mandatory:$m, valueType:$t}'
  }
  CLAIMS="$(jq -s . <(
    claim '["family_name"]' "Family name" "Apellidos" true string
    claim '["given_name"]' "Given name" "Nombre" true string
    claim '["birthdate"]' "Date of birth" "Fecha de nacimiento" true date
    claim '["place_of_birth","country"]' "Country of birth" "País de nacimiento" true string
    claim '["place_of_birth","locality"]' "Place of birth" "Lugar de nacimiento" false string
    claim '["nationalities"]' "Nationalities" "Nacionalidades" true 'string[]'
    claim '["issuing_authority"]' "Issuing authority" "Autoridad emisora" true string
    claim '["issuing_country"]' "Issuing country" "País emisor" true string
  ))"
  TYPE_ID="$(need "Create the credential type" "$(api POST "$T/credential-types" "$(jq -n \
    --arg p "$PROVIDER_ID" --argjson claims "$CLAIMS" --arg commit "$RULEBOOK_COMMIT" '{
      attestationProviderId: $p,
      name: "Test PID (synthetic, TEST ONLY)",
      format: "dc+sd-jwt",
      vct: "urn:eudi:pid:1",
      rulebook: {
        identifier: "urn:eudi:rulebook:pid",
        version: ("catalog commit " + $commit[0:7] + ", change log to v1.7"),
        publicationUri: ("https://github.com/eu-digital-identity-wallet/eudi-doc-attestation-rulebooks-catalog/blob/" + $commit + "/rulebooks/pid/pid-rulebook.md"),
        anchorSource: "RULEBOOK_AND_PUBLISHED_LIST"
      },
      claims: $claims,
      display: [{lang:"en", value:"TEST PID - synthetic"}, {lang:"es", value:"PID de PRUEBA - sintético"}],
      validitySeconds: 2592000,
      statusMechanism: "TOKEN_STATUS_LIST",
      requiresKeyBinding: true
    }')")" credentialTypeId)"
  remember credentialTypeId "$TYPE_ID"
else
  echo "==> Reusing credential type $TYPE_ID"
fi

# --- Issuance policy -------------------------------------------------------------------------------
POLICY_ID="$(recall issuancePolicyId)"
if [ -z "$POLICY_ID" ]; then
  echo "==> Issuance policy, published"
  POLICY_ID="$(need "Create the policy" "$(api POST "$T/issuance-policies" \
    "$(jq -n --arg t "$TYPE_ID" '{credentialTypeId:$t, name:"Test PID from the operator form"}')")" policyId)"
  need "Publish the policy version" "$(api POST "$T/issuance-policies/$POLICY_ID/versions" "$(jq -n \
    --arg t "$TYPE_ID" '{
      credentialTypeId: $t,
      purpose: [{lang:"en", value:"Issue a synthetic test PID for development testing only"},
                {lang:"es", value:"Emitir un PID de prueba sintético, solo para pruebas de desarrollo"}],
      eligibilityRule: { evaluator: "AlwaysEligible", parameters: {} },
      authenticSource: { connector: "operator-form", parameters: { fixedClaims: {
        issuing_authority: "EDTP Test PID Provider - TEST ONLY",
        issuing_country: "ES"
      } } },
      holderBinding: "KEY_BOUND",
      flow: "PRE_AUTHORIZED_CODE",
      credentialValiditySeconds: 604800,
      statusPolicy: { statusListEnabled: true, suspensionAllowed: false },
      publish: true
    }')")" version >/dev/null
  remember issuancePolicyId "$POLICY_ID"
else
  echo "==> Reusing issuance policy $POLICY_ID"
fi

echo
echo "==> What this provider holds"
api GET "$T/attestation-providers/$PROVIDER_ID/provider-authentication" | jq '{canSignAttestations, certificates}'

cat <<EOF

Test PID issuer ready. Ids in $STATE.

  attestation provider  $PROVIDER_ID  (engine tenant $ENGINE_TENANT_REF)
  credential type       $TYPE_ID
  issuance policy       $POLICY_ID

Issue one from the console's "Test PID" page, or:

  curl -X POST $BASE_URL/v1/issuances -H "authorization: Bearer \$KEY" -H 'content-type: application/json' \\
    -d '{"policyId":"$POLICY_ID","subjectReference":"operator-form-1",
         "subjectAttributes":{"family_name":"TEST","given_name":"FORM","birthdate":"1990-01-01",
           "place_of_birth":{"country":"ES"},"nationalities":["ES"]}}'

Synthetic data only. What it issues is test data under a development CA, not a PID.
EOF
