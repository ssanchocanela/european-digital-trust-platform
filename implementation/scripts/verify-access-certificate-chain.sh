#!/usr/bin/env bash
# Verify that an issued access certificate chains to an anchor in the EUDIW development
# WRPACProviders LoTE.
#
#   ./scripts/verify-access-certificate-chain.sh rpac.p12
#   ./scripts/verify-access-certificate-chain.sh --pem leaf.crt [chain.crt]
#
# **This is the first step before any wallet test.** A Wallet Unit accepts only trust anchors from
# the Access Certificate Authority LoTEs notified by Member States — ARF `AS-WP-06-005` (`RPA_04`) —
# so a certificate that does not chain to one of them cannot work, and attempting a wallet test
# before checking wastes the attempt and produces a misleading failure.
#
# Outcome:
#   exit 0  the leaf chains to a LoTE anchor. Record the matched anchor in
#           docs/reference-wallet-testing.md §8 and proceed with Path A.
#   exit 1  it does not. Record that, then fall back to the self-built wallet (Path B) with its
#           development Access CA.
#
# The P12 and its password are secrets. The password is **never** a command-line argument, to
# this script or to openssl: it is read from $P12_PASSWORD or from an interactive prompt, and
# handed to openssl through the environment (`-passin env:`). `pass:` on an openssl argv would be
# readable by any process on the machine through `ps`, which defeats the point of prompting.
# The script writes nothing outside a mode-700 temporary directory, removes it on exit, and
# nothing it prints contains key material.
set -euo pipefail

LOTE_URL="${LOTE_URL:-https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/WRPACProviders.jwt}"

for tool in openssl python3 curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required." >&2; exit 2; }
done

WORK=$(mktemp -d); chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

# --- 1. obtain the leaf and any intermediates -------------------------------------------

if [ "${1:-}" = "--pem" ]; then
  LEAF="${2:?usage: --pem <leaf.crt> [chain.crt]}"
  cp "$LEAF" "$WORK/leaf.pem"
  [ -n "${3:-}" ] && cp "$3" "$WORK/intermediates.pem"
else
  P12="${1:?usage: verify-access-certificate-chain.sh <file.p12> | --pem <leaf.crt> [chain.crt]}"
  if [ -n "${P12_PASSWORD:-}" ]; then
    EDTP_P12_PASSIN="$P12_PASSWORD"
  else
    read -r -s -p "PKCS#12 passphrase: " EDTP_P12_PASSIN; echo
  fi
  export EDTP_P12_PASSIN
  openssl pkcs12 -in "$P12" -clcerts -nokeys -passin env:EDTP_P12_PASSIN -out "$WORK/leaf.pem" 2>/dev/null
  openssl pkcs12 -in "$P12" -cacerts -nokeys -passin env:EDTP_P12_PASSIN -out "$WORK/intermediates.pem" 2>/dev/null || true
  unset EDTP_P12_PASSIN
fi
chmod 600 "$WORK"/*.pem 2>/dev/null || true

echo "Leaf certificate under test:"
openssl x509 -in "$WORK/leaf.pem" -noout -subject -issuer -dates | sed 's/^/  /'
echo

# --- 2. extract the LoTE anchors ---------------------------------------------------------

echo "Fetching the WRPACProviders LoTE:"
echo "  $LOTE_URL"
curl -fsS --max-time 30 "$LOTE_URL" -o "$WORK/lote.jwt"

python3 - "$WORK/lote.jwt" "$WORK/anchors" <<'PY'
import base64, json, pathlib, sys

def b64url(segment: str) -> bytes:
    segment += "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment)

raw = pathlib.Path(sys.argv[1]).read_text().strip()
payload = json.loads(b64url(raw.split(".")[1]))
out = pathlib.Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)

written = 0
lote = payload["LoTE"]
scheme = lote["ListAndSchemeInformation"]
print("  scheme:      ", scheme.get("SchemeName", [{}])[0].get("value", "?"))
print("  issued:      ", scheme.get("ListIssueDateTime", "?"))
print("  next update: ", scheme.get("NextUpdate", "?"))

for entity in lote.get("TrustedEntitiesList", []):
    for service in entity.get("TrustedEntityServices", []):
        info = service.get("ServiceInformation", service)
        type_id = str(info.get("ServiceTypeIdentifier", ""))
        # Issuance services only: a Revocation entry repeats the same anchor.
        if not type_id.endswith("/Issuance"):
            continue
        names = info.get("ServiceName") or [{}]
        name = names[0].get("value", f"anchor-{written}")
        for cert in info.get("ServiceDigitalIdentity", {}).get("X509Certificates", []):
            der = base64.b64decode(cert["val"])
            path = out / f"{written:02d}.der"
            path.write_bytes(der)
            (out / f"{written:02d}.name").write_text(name)
            written += 1

print(f"  anchors:      {written}")
if written == 0:
    raise SystemExit("The LoTE contained no issuance anchors. Refusing to report a pass.")
PY

# --- 3. build a single trust store and verify --------------------------------------------

: > "$WORK/anchors.pem"
for der in "$WORK"/anchors/*.der; do
  openssl x509 -inform DER -in "$der" >> "$WORK/anchors.pem"
done

echo
VERIFY_ARGS=(-CAfile "$WORK/anchors.pem")
[ -s "$WORK/intermediates.pem" ] && VERIFY_ARGS+=(-untrusted "$WORK/intermediates.pem")

# `-partial_chain` accepts a path terminating at any listed anchor, which is what a LoTE entry is:
# a trust anchor, not necessarily a self-signed root.
if openssl verify -partial_chain "${VERIFY_ARGS[@]}" "$WORK/leaf.pem" > "$WORK/result" 2>&1; then
  echo "PASS — the leaf chains to a LoTE anchor."
  echo
  # Name the matched anchor by re-verifying against each one alone.
  for der in "$WORK"/anchors/*.der; do
    openssl x509 -inform DER -in "$der" > "$WORK/single.pem"
    single=("${VERIFY_ARGS[@]}"); single[1]="$WORK/single.pem"
    if openssl verify -partial_chain "${single[@]}" "$WORK/leaf.pem" >/dev/null 2>&1; then
      echo "  matched anchor: $(cat "${der%.der}.name")"
      echo "  anchor SHA-256: $(openssl x509 -inform DER -in "$der" -noout -fingerprint -sha256 | cut -d= -f2)"
    fi
  done
  echo
  echo "Next: record this result in docs/reference-wallet-testing.md §8 and proceed with Path A."
  exit 0
fi

echo "FAIL — the leaf does not chain to any anchor in the LoTE."
sed 's/^/  /' "$WORK/result"
cat <<'GUIDANCE'

This certificate will be refused by an official Reference Implementation build:
`AS-WP-06-005` (`RPA_04`) makes the Wallet accept only Access CA trust anchors from the notified
LoTEs, and the shipped build enables no preregistered-client escape hatch.

Record the failure in docs/reference-wallet-testing.md §8, then fall back to Path B — a self-built
wallet with a development Access CA in its reader trust store. Label every result from it as a
modified wallet.
GUIDANCE
exit 1
