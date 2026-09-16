#!/usr/bin/env bash
# Replaces an Attestation Provider's attestation-signing certificate.
#
#   PLATFORM_TENANT_API_KEY=… ./scripts/rotate-attestation-key.sh <attestationProviderId>
#   PLATFORM_TENANT_API_KEY=… CERT_DAYS=365 ./scripts/rotate-attestation-key.sh <id>
#
# ## Why this exists
#
# On 16 September 2026 an issuance chain stopped working because its signing certificate had expired
# two days earlier, and there was no way to replace it except hand-rolled `curl`. Everything up to
# the last call of the flow still answered 200 — the offer minted, resolved over public HTTPS, the
# token endpoint issued a DPoP-bound access token — and the refusal arrived only at
# `POST /vci/credential` as `credential_request_denied`. Rotating a key is an ordinary operational
# act; it should not be an act of improvisation.
#
# ## What it does NOT do, and why that matters more than what it does
#
# `POST …/provision` **replaces the whole provisioning record**. An access certificate that is not
# supplied is cleared, deliberately (`issuance.repository.ts`) — and then every issuance under a
# provider that has *any* gated policy fails `attestation_provider_has_no_access_certificate`,
# including issuances of policies with no gate at all, because the issuer configuration is composed
# per provider (`interop-findings.md` A20).
#
# That is a trap, and it caught this project once. So this script **reads the provider's current
# state first** and refuses to run if it holds an access certificate that it has not been given a
# replacement for. Rotating a signing key should not silently remove a different key.
#
# ## Secrets
#
# The private key is generated here, sent once, and never written anywhere but a `mktemp -d`
# directory removed on exit. The platform stores only the opaque reference the engine returns. The
# tenant key is read from the environment because an argument is visible in the process list.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3100}"
KEY="${PLATFORM_TENANT_API_KEY:?set PLATFORM_TENANT_API_KEY; it is a secret and must not be an argument}"
PROVIDER_ID="${1:-}"
CERT_DAYS="${CERT_DAYS:-90}"
SUBJECT="${CERT_SUBJECT:-/CN=EDTP Attestation Provider/O=Development only/C=EU}"
ACCESS_CA_DIR="${EDTP_DEV_CA_DIR:-$HOME/.edtp/dev-access-ca}"

if [ -z "$PROVIDER_ID" ]; then
  echo "usage: PLATFORM_TENANT_API_KEY=… $0 <attestationProviderId>" >&2
  exit 1
fi

for tool in curl jq node openssl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required." >&2; exit 1; }
done

api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE_URL$path" \
      -H "authorization: Bearer $KEY" -H 'content-type: application/json' --data-binary "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" -H "authorization: Bearer $KEY"
  fi
}

TENANT_ID="$(api GET /v1/me | jq -r '.tenantId // empty')"
[ -n "$TENANT_ID" ] || { echo "Could not identify the tenant. Is PLATFORM_TENANT_API_KEY correct?" >&2; exit 1; }

PROVIDER_PATH="/v1/tenants/$TENANT_ID/attestation-providers/$PROVIDER_ID"

echo "==> What this provider holds now"
BEFORE="$(api GET "$PROVIDER_PATH/provider-authentication")"
if [ -n "$(echo "$BEFORE" | jq -r '.error // empty')" ]; then
  echo "$BEFORE" | jq '{error, message}' >&2
  exit 1
fi
echo "$BEFORE" | jq '{canSignAttestations, certificates}'

# --- the A20 trap, refused rather than sprung -----------------------------------------------------
HAS_ACCESS="$(echo "$BEFORE" | jq -r 'if .certificates.access then "yes" else "no" end')"
if [ "$HAS_ACCESS" = "yes" ] && [ ! -f "$ACCESS_CA_DIR/access.crt" ]; then
  cat >&2 <<GUIDE

  REFUSING TO RUN.

  This provider holds an access certificate, and \`provision\` replaces the whole record — so a
  rotation that sends only a signing certificate would remove it. Every issuance under a provider
  with any gated policy would then fail \`attestation_provider_has_no_access_certificate\`,
  including issuances of policies that have no gate, because the issuer configuration is composed
  per provider (interop-findings.md A20).

  No access certificate was found at $ACCESS_CA_DIR to send alongside. Either point
  EDTP_DEV_CA_DIR at the directory holding access.crt, access.key8.pem and ca.crt, or create one
  with scripts/make-dev-access-ca.sh.

GUIDE
  exit 1
fi

# --- the new signing key --------------------------------------------------------------------------
WORK="$(mktemp -d)"; chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/key.pem" 2>/dev/null
openssl pkcs8 -topk8 -nocrypt -in "$WORK/key.pem" -out "$WORK/key8.pem" 2>/dev/null
openssl req -new -x509 -key "$WORK/key.pem" -out "$WORK/cert.pem" -days "$CERT_DAYS" \
  -subj "$SUBJECT" 2>/dev/null
chmod 600 "$WORK"/*.pem

echo
echo "==> New attestation-signing certificate"
echo "    valid until $(openssl x509 -in "$WORK/cert.pem" -noout -enddate | cut -d= -f2)"
echo "    Self-signed, and that is not what blocks issuance: gate (b) of ARF §6.3.2.4 takes its"
echo "    anchors from the Rulebook, not from this chain."

jwk() {
  node -e 'const{readFileSync}=require("node:fs");const{createPrivateKey}=require("node:crypto");
    process.stdout.write(JSON.stringify(createPrivateKey(readFileSync(process.argv[1],"utf8")).export({format:"jwk"})))' "$1"
}
pems() {
  node -e 'const{readFileSync}=require("node:fs");
    process.stdout.write(JSON.stringify(process.argv.slice(1).map((p)=>readFileSync(p,"utf8"))))' "$@"
}

ENGINE_TENANT_REF="${ENGINE_TENANT_REF:-rpi-1}"
BODY="$(jq -n \
  --arg ref "$ENGINE_TENANT_REF" \
  --argjson sjwk "$(jwk "$WORK/key8.pem")" \
  --argjson schain "$(pems "$WORK/cert.pem")" \
  '{engineTenantRef:$ref, signingCertificate:{privateKeyJwk:$sjwk, certificateChain:$schain}}')"

if [ "$HAS_ACCESS" = "yes" ]; then
  echo
  echo "==> Carrying the access certificate through, so the rotation does not remove it"
  echo "    from $ACCESS_CA_DIR, valid until $(openssl x509 -in "$ACCESS_CA_DIR/access.crt" -noout -enddate | cut -d= -f2)"
  BODY="$(echo "$BODY" | jq \
    --argjson ajwk "$(jwk "$ACCESS_CA_DIR/access.key8.pem")" \
    --argjson achain "$(pems "$ACCESS_CA_DIR/access.crt" "$ACCESS_CA_DIR/ca.crt")" \
    '. + {accessCertificate:{privateKeyJwk:$ajwk, certificateChain:$achain}}')"
fi

echo
echo "==> Provisioning"
RESULT="$(api POST "$PROVIDER_PATH/provision" "$BODY")"
echo "$RESULT" | jq '{provisioned, accessCertificateImported, registrationCertificatePublished, error, message}'
if [ -n "$(echo "$RESULT" | jq -r '.error // empty')" ]; then
  echo "Provisioning FAILED. The provider is left as it was." >&2
  exit 1
fi

echo
echo "==> What it holds now"
api GET "$PROVIDER_PATH/provider-authentication" | jq '{canSignAttestations, certificates}'

cat <<'NOTE'

The signing certificate is replaced and its validity is recorded, so the console can say when it
expires instead of discovering it at the last call of an issuance.

Unchanged by this, and unchangeable by it: a Wallet still cannot authenticate this provider. The
engine publishes no signed issuer metadata (blocker B7, ARF §6.6.2.2), and no certificate fixes that.
NOTE
