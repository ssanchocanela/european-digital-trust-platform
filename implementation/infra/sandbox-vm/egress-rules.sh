#!/usr/bin/env bash
# Egress rules for the sandbox's containers (ADR 0020 §6b, docs/interop-findings.md A37).
#
# The engine fetches a wallet attestation's status list from a URL the attestation names, outside its
# own outbound policy. A trusted Wallet Provider can therefore make the engine send a GET to an
# address of its choosing. These rules confine what such a request can reach: from the sandbox's
# Docker network, the containers may talk to each other and to the public internet, and to no other
# private, link-local or shared address — Hetzner's metadata service (169.254.169.254) included.
#
#   sudo infra/sandbox-vm/egress-rules.sh apply     # idempotent; run at boot by edtp-sandbox-egress
#   sudo infra/sandbox-vm/egress-rules.sh check     # exit 0 when the rules are in place
#
# The rules live in their own chain, EDTP-EGRESS, jumped to from DOCKER-USER, which Docker leaves to
# the operator and never flushes.
set -euo pipefail
NETWORK="${EDTP_SANDBOX_NETWORK:-edtp-sandbox_default}"
CHAIN=EDTP-EGRESS
BLOCKED=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 192.0.0.0/24 198.18.0.0/15)

subnet() {
  docker network inspect "$NETWORK" -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | awk '{print $1}'
}

apply() {
  local net
  net="$(subnet)"
  [ -n "$net" ] || { echo "egress-rules: network $NETWORK not found; start the stack first" >&2; exit 1; }
  iptables -N "$CHAIN" 2>/dev/null || true
  iptables -F "$CHAIN"
  # Within the sandbox's own network: allowed (engine -> platform-api, databases).
  iptables -A "$CHAIN" -s "$net" -d "$net" -j RETURN
  for range in "${BLOCKED[@]}"; do
    iptables -A "$CHAIN" -s "$net" -d "$range" -j REJECT --reject-with icmp-net-prohibited
  done
  iptables -A "$CHAIN" -j RETURN
  iptables -C DOCKER-USER -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER 1 -j "$CHAIN"
  echo "egress-rules: $CHAIN applied for $net (${#BLOCKED[@]} ranges refused)"
}

check() {
  local net
  net="$(subnet)"
  iptables -C DOCKER-USER -j "$CHAIN" 2>/dev/null || { echo "egress-rules: DOCKER-USER does not jump to $CHAIN"; exit 1; }
  iptables -C "$CHAIN" -s "$net" -d 169.254.0.0/16 -j REJECT --reject-with icmp-net-prohibited 2>/dev/null ||
    { echo "egress-rules: the metadata range is not refused for $net"; exit 1; }
  echo "egress-rules: in place for $net"
}

case "${1:-}" in
  apply) apply ;;
  check) check ;;
  *) echo "usage: $0 apply|check" >&2; exit 64 ;;
esac
