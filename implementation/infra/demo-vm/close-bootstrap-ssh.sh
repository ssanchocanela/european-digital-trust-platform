#!/usr/bin/env bash
# Closes the bootstrap SSH rule on the demonstration VM's Hetzner firewall, leaving it with NO inbound
# rules at all (ADR 0010). Run it only once SSH works through the VM's own Cloudflare tunnel —
# afterwards the public address answers nothing, and the provider's console is the fallback.
#
#   ./infra/demo-vm/close-bootstrap-ssh.sh
set -euo pipefail
TOKEN="$(cat "${HCLOUD_TOKEN_FILE:-$HOME/.edtp/hetzner.token}")"
NAME="${EDTP_DEMO_VM_NAME:-edtp-demo}"
api() {
  curl -sS -X "$1" "https://api.hetzner.cloud/v1$2" -H "Authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' ${3:+--data-binary "$3"}
}
FW_ID="$(api GET "/firewalls?name=$NAME" | jq -r '.firewalls[0].id // empty')"
[ -n "$FW_ID" ] || { echo "no firewall named $NAME" >&2; exit 1; }
api POST "/firewalls/$FW_ID/actions/set_rules" '{"rules":[]}' >/dev/null
echo "Firewall $FW_ID: inbound rules now $(api GET "/firewalls/$FW_ID" | jq '.firewall.rules | length') (none)."
