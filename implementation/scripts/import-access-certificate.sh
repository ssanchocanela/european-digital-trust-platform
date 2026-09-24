#!/usr/bin/env bash
# Converts a PKCS#12 access certificate into the shape the platform's provisioning endpoint
# accepts, and provisions the Relying Party Instance with it.
#
#   TENANT_ID=<tenant-id> PLATFORM_TENANT_API_KEY=<key> \
#     ./scripts/import-access-certificate.sh <service-id> <engine-tenant-ref> <file.p12>
#
# Neither the tenant API key nor the PKCS#12 passphrase is a command-line argument, to this
# script or to openssl. Both are secrets, and an argv is readable by any process on the machine
# through `ps` as well as landing in shell history.
#
# Why a conversion step exists: the engine's key-chain import endpoint takes an **EC private
# key in JWK form** plus a certificate chain (leaf first, PEM), not a PKCS#12 blob. Its web
# wizard accepts P12 files because the UI converts them. See docs/interop-findings.md A8.
#
# The private key exists only in a file mode 600 under a temporary directory that is removed
# on exit, and in the request body. The platform never stores it: it keeps only the opaque
# key-binding reference the engine returns.
set -euo pipefail

SERVICE_ID="${1:?usage: import-access-certificate.sh <service-id> <engine-tenant-ref> <file.p12>}"
ENGINE_TENANT_REF="${2:?engine tenant reference}"
P12="${3:?path to the PKCS#12 file}"
BASE_URL="${BASE_URL:-http://localhost:3100}"
TENANT_ID="${TENANT_ID:?set TENANT_ID}"
TENANT_KEY="${PLATFORM_TENANT_API_KEY:?set PLATFORM_TENANT_API_KEY; it is a secret and must not be an argument}"

for tool in openssl jq node curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required." >&2; exit 1; }
done

WORK=$(mktemp -d)
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

if [ -n "${P12_PASSWORD:-}" ]; then
  EDTP_P12_PASSIN="$P12_PASSWORD"
else
  read -r -s -p "PKCS#12 passphrase: " EDTP_P12_PASSIN
  echo
fi
export EDTP_P12_PASSIN

# `-passin env:` rather than `pass:` — see the header. The variable is unset immediately after.
openssl pkcs12 -in "$P12" -nocerts -nodes -passin env:EDTP_P12_PASSIN -out "$WORK/key.pem" 2>/dev/null
openssl pkcs12 -in "$P12" -clcerts -nokeys -passin env:EDTP_P12_PASSIN -out "$WORK/leaf.pem" 2>/dev/null
# CA certificates, if the P12 carries a chain. Leaf first is what the engine expects.
openssl pkcs12 -in "$P12" -cacerts -nokeys -passin env:EDTP_P12_PASSIN -out "$WORK/ca.pem" 2>/dev/null || true
unset EDTP_P12_PASSIN
chmod 600 "$WORK"/*.pem

echo "Leaf certificate:"
openssl x509 -in "$WORK/leaf.pem" -noout -subject -issuer -dates

JWK=$(node -e '
const { readFileSync } = require("node:fs");
const { createPrivateKey } = require("node:crypto");
const key = createPrivateKey(readFileSync(process.argv[1], "utf8"));
const jwk = key.export({ format: "jwk" });
if (jwk.kty !== "EC") {
  process.stderr.write(`Expected an EC key; the engine key chain requires one. Found ${jwk.kty}.\n`);
  process.exit(1);
}
process.stdout.write(JSON.stringify(jwk));
' "$WORK/key.pem")

CHAIN=$(node -e '
const { readFileSync, existsSync } = require("node:fs");
const parts = [];
const take = (p) => {
  if (!existsSync(p)) return;
  const text = readFileSync(p, "utf8");
  for (const m of text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)) {
    parts.push(m[0]);
  }
};
take(process.argv[1]);  // leaf first
take(process.argv[2]);  // then any CA certificates
process.stdout.write(JSON.stringify(parts));
' "$WORK/leaf.pem" "$WORK/ca.pem")

SUBJECT=$(openssl x509 -in "$WORK/leaf.pem" -noout -subject | sed 's/^subject= *//')
ISSUER=$(openssl x509 -in "$WORK/leaf.pem" -noout -issuer | sed 's/^issuer= *//')

curl -sS -X POST "$BASE_URL/v1/tenants/$TENANT_ID/rp-services/$SERVICE_ID/instance" \
  -H "authorization: Bearer $TENANT_KEY" \
  -H 'content-type: application/json' \
  -d "$(jq -n \
        --arg ref "$ENGINE_TENANT_REF" \
        --argjson jwk "$JWK" \
        --argjson chain "$CHAIN" \
        --arg subject "$SUBJECT" \
        --arg issuer "$ISSUER" \
        '{
           engineTenantRef: $ref,
           trustEnvironment: "TEST",
           accessCertificate: {
             privateKeyJwk: $jwk,
             certificateChain: $chain,
             subject: $subject,
             issuer: $issuer
           }
         }')" | jq .

echo
echo "Imported. The platform stored only the key-binding reference; the private key was not"
echo "persisted by the platform and the temporary files have been removed."
