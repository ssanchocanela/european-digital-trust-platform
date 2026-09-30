#!/usr/bin/env bash
# Prepares the age verification issuer on the demonstration VM (ADR 0012). Run once, on the VM, after
# copying from the issuer's machine (the laptop that ran deploy/issuer-local):
#
#   scp <checkout>/pki/out/issuer.p12 <checkout>/pki/out/wallet-provider.p12 edtp-demo:.av/issuer-pki/
#   python3 <checkout>/scripts/make-test-wrprc.py | ssh edtp-demo 'umask 077; cat > .av/issuer-wrprc'
#
# then:  infra/demo-vm/av-issuer/setup-issuer.sh
#
# The keystores are that machine's TEST keys, so the attestations it issued stay valid and the verifier's
# trust store (the same Document Signer) needs no change. It writes ~/.av/issuer.env: a random Keycloak
# admin password, the keystores' password (asked for), the registration certificate, the public base.
# Idempotent; --rotate-admin writes a new admin password (it takes effect only on a new Keycloak database).
set -euo pipefail

AV_DIR="$HOME/.av"
PKI="$AV_DIR/issuer-pki"
ENV_FILE="$AV_DIR/issuer.env"
WRPRC_FILE="$AV_DIR/issuer-wrprc"

for f in issuer.p12 wallet-provider.p12; do
  [ -f "$PKI/$f" ] || { echo "missing $PKI/$f: copy it from the issuer's machine first (see the header)" >&2; exit 1; }
done
[ -s "$WRPRC_FILE" ] || { echo "missing $WRPRC_FILE: generate it with make-test-wrprc.py (see the header)" >&2; exit 1; }

# ~/.av is 700, so these are reachable by the containers' unprivileged users and by nobody else here.
chmod 700 "$AV_DIR"
chmod 755 "$PKI"
chmod 644 "$PKI"/*.p12

if [ ! -f "$ENV_FILE" ] || [ "${1:-}" = --rotate-admin ]; then
  read -r -s -p "Password of the keystores (the issuer machine's PKI password): " pki_password; echo
  tag="$(sed -n 's/^AV_ISSUER_IMAGE_TAG=//p' "$ENV_FILE" 2>/dev/null || true)"
  umask 077
  cat > "$ENV_FILE" <<ENV
AV_ISSUER_IMAGE_TAG=$tag
AV_ISSUER_PUBLIC_BASE=https://issuer-dev.murcata.es
KC_ADMIN_PASSWORD=$(openssl rand -hex 24)
AV_PKI_PASSWORD=$pki_password
AV_WRPRC=$(tr -d '\n' < "$WRPRC_FILE")
ENV
  echo "wrote $ENV_FILE"
fi
echo "done. Deploy with: deploy-av <12-hex tag>, which brings the issuer up too once this file exists."
