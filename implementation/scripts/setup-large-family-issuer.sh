#!/usr/bin/env bash
# Sets up the fictitious autonomous community that issues the Large Family Title: its organisation,
# its Attestation Provider (TEST) and its attestation-signing certificate, on its own engine tenant.
#
#   ./scripts/create-engine-tenant.sh fam-1 "Comunidad Autonoma Demo"   # once; restart platform-api
#   PLATFORM_TENANT_API_KEY=… ./scripts/setup-large-family-issuer.sh
#
# Then, in this order:
#   1. add the saved certificate to the EDTP TEST list of EAA providers and republish it:
#        node scripts/make-test-lote.mjs --kind eaa \
#          --ca ~/.edtp/eaa-provider/ca.crt,~/.edtp/eaa-provider/fam-1.crt --url … --out …
#      and reload it into the engine (scripts/load-issuer-trust-list.mjs), or the fibre operator's
#      policy will refuse every title as untrusted;
#   2. node scripts/register-large-family.mjs issuance <attestationProviderId> <identifyPolicyId>
#
# Idempotent: the ids are kept in ~/.edtp/large-family-issuer.json and a provider already
# provisioned is reused, never re-keyed. Rotating its key is rotate-attestation-key.sh's job.
#
# ## Why a tenant of its own
#
# The title is issued by an autonomous community, not by the register that issues the
# representation credentials, and a wallet shows the Credential Issuer's name. One engine tenant per
# Attestation Provider (`interop-findings.md` A20), so a second issuer needs a second tenant — and,
# for the wallet's own list to offer it, a third WD-5 issuer (`tools/test-wallet/deviations.md`).
#
# ## What it is not
#
# The community, its register and its certificate exist nowhere. The signing certificate is
# self-signed, like the register's: a verifier trusts it only through our TEST list, which is not a
# notified list. `TEST` environment only.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3100}"
KEY="${PLATFORM_TENANT_API_KEY:?set PLATFORM_TENANT_API_KEY; it is a secret and must not be an argument}"
ENGINE_TENANT_REF="${ENGINE_TENANT_REF:-fam-1}"
STATE="${EDTP_LARGE_FAMILY_ISSUER_STATE:-$HOME/.edtp/large-family-issuer.json}"
CERT_OUT="${EDTP_LARGE_FAMILY_CERT:-$HOME/.edtp/eaa-provider/$ENGINE_TENANT_REF.crt}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for tool in curl jq openssl node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required." >&2; exit 1; }
done

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

PROVIDER_ID="$(recall attestationProviderId)"
PROVIDER_STATE="absent"
if [ -n "$PROVIDER_ID" ]; then
  case "$(api GET "$T/attestation-providers/$PROVIDER_ID/provider-authentication" | jq -r '.error // "ok"')" in
    ok) PROVIDER_STATE="ready" ;;
    attestation_provider_not_provisioned) PROVIDER_STATE="registered" ;;
  esac
fi

if [ "$PROVIDER_STATE" = "absent" ]; then
  echo "==> Organisation"
  ORG_ID="$(need "Register the organisation" "$(api POST "$T/organisations" '{
    "legalName": "Comunidad Autonoma Demo, Consejeria de Familia - TEST ONLY, fictitious",
    "memberState": "ES",
    "isPublicSectorBody": true,
    "officialIdentifiers": [{ "scheme": "http://data.europa.eu/eudi/id/EUID", "value": "ESTEST.EDTPFAM1" }]
  }')" organisationId)"
  echo "==> Attestation Provider (TEST)"
  PROVIDER_ID="$(need "Register the provider" "$(api POST "$T/attestation-providers" "$(jq -n \
    --arg org "$ORG_ID" \
    '{organisationId:$org, registrarAssignedIdentifier:"ESTEST.EDTP-FAM-PROVIDER-1",
      registrar:"none - TEST, no Registrar involved", trustEnvironment:"TEST"}')")" attestationProviderId)"
  remember attestationProviderId "$PROVIDER_ID"
  PROVIDER_STATE="registered"
fi

if [ "$PROVIDER_STATE" = "registered" ]; then
  echo "==> Self-signed attestation-signing certificate, on $ENGINE_TENANT_REF"
  mkdir -p "$(dirname "$CERT_OUT")"
  ENGINE_TENANT_REF="$ENGINE_TENANT_REF" PLATFORM_TENANT_API_KEY="$KEY" BASE_URL="$BASE_URL" \
    CERT_DAYS="${CERT_DAYS:-365}" SAVE_SIGNING_CERT="$CERT_OUT" \
    CERT_SUBJECT="/CN=Comunidad Autonoma Demo - large family titles - TEST ONLY/O=EDTP development/C=ES" \
    "$HERE/rotate-attestation-key.sh" "$PROVIDER_ID"
else
  echo "==> Reusing Attestation Provider $PROVIDER_ID (already provisioned; not re-keyed)"
fi

cat <<NEXT

Attestation Provider $PROVIDER_ID, engine tenant $ENGINE_TENANT_REF.
Signing certificate: $CERT_OUT

Next:
  1. add $CERT_OUT to the EDTP TEST list of EAA providers (make-test-lote.mjs --kind eaa), publish
     it, and reload it into the engine — see this script's header;
  2. node scripts/register-large-family.mjs issuance $PROVIDER_ID <identifyPolicyId>
  3. name the issuer for the wallet: ENGINE_ISSUER_DISPLAY_NAMES gains "$ENGINE_TENANT_REF=Comunidad Autónoma Demo".
NEXT
