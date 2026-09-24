#!/usr/bin/env bash
# Creates the demonstration VM on Hetzner Cloud (ADR 0010): cx23, fsn1, Ubuntu 24.04 LTS.
#
#   ./infra/demo-vm/create-server.sh
#
# Reads the Hetzner API token from ~/.edtp/hetzner.token (mode 600, never printed, never committed).
# Idempotent: an existing key, firewall or server of the same name is reused, not duplicated.
#
# ## Inbound access, and why SSH is open for a while
#
# ADR 0010 allows no inbound ports: everything, SSH included, is to come through the VM's own
# Cloudflare tunnel. That tunnel does not exist on first boot, so the firewall opens **port 22 to one
# address only** — the operator's current public IPv4, passed explicitly — for the bootstrap.
# `close-bootstrap-ssh.sh` removes the rule once the tunnel carries SSH. Everything else is denied
# inbound from the start.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_FILE="${HCLOUD_TOKEN_FILE:-$HOME/.edtp/hetzner.token}"
KEY_DIR="${EDTP_DEMO_VM_KEY_DIR:-$HOME/.edtp/demo-vm}"
NAME="${EDTP_DEMO_VM_NAME:-edtp-demo}"
TYPE="${EDTP_DEMO_VM_TYPE:-cx23}"
LOCATION="${EDTP_DEMO_VM_LOCATION:-fsn1}"
IMAGE="${EDTP_DEMO_VM_IMAGE:-ubuntu-24.04}"
BOOTSTRAP_IP="${EDTP_BOOTSTRAP_IP:?set EDTP_BOOTSTRAP_IP to your public IPv4: the one address SSH is opened to during bootstrap}"

die() { echo "create-server: $*" >&2; exit 1; }
[ -f "$TOKEN_FILE" ] || die "no Hetzner token at $TOKEN_FILE."
[[ "$BOOTSTRAP_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "EDTP_BOOTSTRAP_IP must be a single IPv4 address."
TOKEN="$(cat "$TOKEN_FILE")"
api() { # <method> <path> [json]
  curl -sS -X "$1" "https://api.hetzner.cloud/v1$2" -H "Authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' ${3:+--data-binary "$3"}
}

# --- SSH key, dedicated to this VM --------------------------------------------------------------
mkdir -p "$KEY_DIR" && chmod 700 "$KEY_DIR"
[ -f "$KEY_DIR/id_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -C "$NAME" -f "$KEY_DIR/id_ed25519"
PUB="$(cat "$KEY_DIR/id_ed25519.pub")"
KEY_ID="$(api GET "/ssh_keys?name=$NAME" | jq -r '.ssh_keys[0].id // empty')"
if [ -z "$KEY_ID" ]; then
  KEY_ID="$(api POST /ssh_keys "$(jq -n --arg n "$NAME" --arg k "$PUB" '{name:$n, public_key:$k}')" | jq -r '.ssh_key.id')"
fi
echo "==> SSH key $KEY_ID"

# --- Firewall: deny all inbound but SSH from one address ------------------------------------------
FW_ID="$(api GET "/firewalls?name=$NAME" | jq -r '.firewalls[0].id // empty')"
RULES="$(jq -n --arg ip "$BOOTSTRAP_IP/32" '[{direction:"in", protocol:"tcp", port:"22",
  source_ips:[$ip], description:"bootstrap SSH, one address; removed by close-bootstrap-ssh.sh"}]')"
if [ -z "$FW_ID" ]; then
  FW_ID="$(api POST /firewalls "$(jq -n --arg n "$NAME" --argjson r "$RULES" '{name:$n, rules:$r}')" | jq -r '.firewall.id')"
else
  api POST "/firewalls/$FW_ID/actions/set_rules" "$(jq -n --argjson r "$RULES" '{rules:$r}')" >/dev/null
fi
echo "==> Firewall $FW_ID (inbound: tcp/22 from $BOOTSTRAP_IP only)"

# --- Server ---------------------------------------------------------------------------------------
SERVER="$(api GET "/servers?name=$NAME" | jq -c '.servers[0] // empty')"
if [ -z "$SERVER" ]; then
  USER_DATA="$(sed "s|__SSH_PUBLIC_KEY__|$PUB|" "$HERE/cloud-init.yaml")"
  SERVER="$(api POST /servers "$(jq -n --arg n "$NAME" --arg t "$TYPE" --arg l "$LOCATION" --arg i "$IMAGE" \
    --arg u "$USER_DATA" --argjson k "$KEY_ID" --argjson f "$FW_ID" '{
      name:$n, server_type:$t, location:$l, image:$i, user_data:$u, ssh_keys:[$k],
      firewalls:[{firewall:$f}], labels:{project:"edtp", role:"demo"},
      public_net:{enable_ipv4:true, enable_ipv6:true}
    }')" | jq -c '.server // .error')"
  echo "$SERVER" | jq -e '.id' >/dev/null || die "server creation refused: $SERVER"
  echo "==> Server created"
else
  echo "==> Server exists, reused"
fi
echo "$SERVER" | jq -r '"    id \(.id), \(.server_type.name // "'"$TYPE"'"), \(.datacenter.name // "'"$LOCATION"'"), ipv4 \(.public_net.ipv4.ip)"'
IPV4="$(echo "$SERVER" | jq -r '.public_net.ipv4.ip')"
echo "$IPV4" > "$KEY_DIR/ipv4"
echo
echo "First boot takes a few minutes (package upgrade, Docker, cloudflared). Then:"
echo "  ssh -i $KEY_DIR/id_ed25519 edtp@$IPV4 test -f /var/lib/edtp-bootstrap-done && echo ready"
