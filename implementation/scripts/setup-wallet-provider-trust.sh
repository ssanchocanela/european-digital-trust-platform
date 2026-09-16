#!/usr/bin/env bash
# Creates the engine-side wallet-provider trust list the token endpoint verifies wallets against.
#
#   ./scripts/setup-wallet-provider-trust.sh            # engine tenant rpi-1, list id below
#   ENGINE_TENANT_REF=rpi-2 ./scripts/setup-wallet-provider-trust.sh
#
# Then set ENGINE_WALLET_PROVIDER_TRUST_LIST_ID in .env and restart platform-api, so the issuer
# configuration it writes requires wallet attestation and references this list.
#
# ## Why it exists
#
# On 16 September 2026 a modified test wallet reached the token endpoint for the first time and was
# refused three different ways in a row, each only visible once the previous one was fixed:
#
#   1. "Client attestation based authentication is not supported by the authorization server"
#      — the wallet authenticates with attest_jwt_client_auth; the engine advertises it only with
#      walletAttestationRequired.
#   2. 401 "No wallet provider trust lists configured for wallet attestation verification"
#   3. 401 "Could not find any entity of type TrustList" — the engine takes a trust list **id**,
#      of a list held in the engine. A URL is not accepted.
#
# And creating that list needs a key with usageType "trustList" first, because the engine re-signs
# every list it holds: 409 "No key chain found with usage type 'trustList'".
#
# ## What it trusts, and what that means
#
# The fourteen wallet-provider services of the EUDI **development** WalletProviders LoTE — the
# notified dev list, fetched live, not a list of ours. A wallet attestation from the EUDI reference
# wallet provider verifies; nothing else does. TEST only: this is a development trust list and must
# never reach a PRODUCTION configuration.
#
# The engine models an entity as an issuer certificate plus a revocation certificate; the LoTE
# publishes one certificate per service, so the same one stands for both. Recorded rather than hidden.
#
# The trustList signing key is the development LoTE signer from scripts/make-dev-access-ca.sh — read
# locally, sent once, written nowhere.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

ENGINE="${ENGINE_BASE_URL:-http://localhost:3000}"
TENANT_REF="${ENGINE_TENANT_REF:-rpi-1}"
LIST_ID="${WALLET_PROVIDER_TRUST_LIST_ID:-eudi-dev-wallet-providers}"
LOTE_URL="${WALLET_PROVIDERS_LOTE:-https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/WalletProviders.jwt}"
CA_DIR="${EDTP_DEV_CA_DIR:-$HOME/.edtp/dev-access-ca}"

for tool in curl jq node python3 openssl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required." >&2; exit 1; }
done

# Engine credentials for the tenant, from .env — the same variable platform-api uses.
CREDS_LINE="$(grep -E '^ENGINE_TENANT_CREDENTIALS=' .env | cut -d= -f2-)"
ENTRY="$(printf '%s' "$CREDS_LINE" | tr ',' '\n' | grep -E "^${TENANT_REF}=" | head -1 || true)"
[ -n "$ENTRY" ] || { echo "no ENGINE_TENANT_CREDENTIALS entry for $TENANT_REF in .env" >&2; exit 1; }
PAIR="${ENTRY#*=}"
TOKEN="$(curl -sS -X POST "$ENGINE/api/oauth2/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode "client_id=${PAIR%%:*}" --data-urlencode "client_secret=${PAIR#*:}" | jq -r '.access_token // empty')"
[ -n "$TOKEN" ] || { echo "could not obtain an engine token for $TENANT_REF" >&2; exit 1; }
api() { curl -sS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }

WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT

echo "==> Trust list $LIST_ID on engine tenant $TENANT_REF"
if [ "$(api -o /dev/null -w '%{http_code}' "$ENGINE/api/trust-list/$LIST_ID")" = "200" ]; then
  echo "    already present — nothing to do"
  exit 0
fi

echo "==> A trustList signing key"
if api "$ENGINE/api/key-chain" | jq -e 'any(.[]; .usageType == "trustList")' >/dev/null; then
  echo "    already present"
else
  for f in lote-signer.key lote-signer.crt; do
    [ -f "$CA_DIR/$f" ] || { echo "missing $CA_DIR/$f — run scripts/make-dev-access-ca.sh" >&2; exit 1; }
  done
  openssl pkcs8 -topk8 -nocrypt -in "$CA_DIR/lote-signer.key" -out "$WORK/k8.pem" 2>/dev/null
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const { createPrivateKey } = require("node:crypto");
    // The engine field names, read from its OpenAPI document: `key`, `crt`, `description`.
    writeFileSync(process.argv[3], JSON.stringify({
      usageType: "trustList",
      description: "EDTP development LoTE signer (TEST)",
      key: createPrivateKey(readFileSync(process.argv[1], "utf8")).export({ format: "jwk" }),
      crt: [readFileSync(process.argv[2], "utf8")],
    }));
  ' "$WORK/k8.pem" "$CA_DIR/lote-signer.crt" "$WORK/key.json"
  CODE="$(api -o "$WORK/key-resp.json" -w '%{http_code}' -X POST "$ENGINE/api/key-chain/import" --data-binary @"$WORK/key.json")"
  [ "$CODE" = "201" ] || { echo "key import failed: $CODE $(cat "$WORK/key-resp.json")" >&2; exit 1; }
  echo "    imported"
fi

echo "==> Fetching the notified dev WalletProviders LoTE"
curl -sS --max-time 30 "$LOTE_URL" -o "$WORK/wp.jwt"

python3 - "$WORK/wp.jwt" "$WORK/list.json" "$LIST_ID" <<'PY'
import base64, json, sys, textwrap
token, out, list_id = sys.argv[1], sys.argv[2], sys.argv[3]
payload = open(token).read().strip().split(".")[1]
payload += "=" * (-len(payload) % 4)
lote = json.loads(base64.urlsafe_b64decode(payload))["LoTE"]
entities = []
for entity in lote["TrustedEntitiesList"]:
    for svc in entity["TrustedEntityServices"]:
        info = svc["ServiceInformation"]
        der = info["ServiceDigitalIdentity"]["X509Certificates"][0]["val"]
        pem = "-----BEGIN CERTIFICATE-----\n" + "\n".join(textwrap.wrap(der, 64)) + "\n-----END CERTIFICATE-----\n"
        entities.append({
            "type": "external",
            "providerType": "wallet-provider",
            "issuerCertPem": pem,
            "revocationCertPem": pem,
            "info": {"name": info["ServiceName"][0]["value"], "lang": "en", "country": "EU"},
        })
json.dump({"id": list_id,
           "description": "EUDI dev Wallet Providers, from the notified dev LoTE (TEST)",
           "entities": entities}, open(out, "w"))
print(f"    {len(entities)} wallet-provider services")
PY

CODE="$(api -o "$WORK/list-resp.json" -w '%{http_code}' -X POST "$ENGINE/api/trust-list" --data-binary @"$WORK/list.json")"
[ "$CODE" = "201" ] || { echo "trust list creation failed: $CODE $(head -c 300 "$WORK/list-resp.json")" >&2; exit 1; }
echo "    created $LIST_ID"
echo
echo "Now set ENGINE_WALLET_PROVIDER_TRUST_LIST_ID=$LIST_ID in .env and recreate platform-api."
