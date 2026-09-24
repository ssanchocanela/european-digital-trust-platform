#!/usr/bin/env bash
# Deploys one published image to the demonstration VM, and rolls back if the negative checks fail
# (ADR 0010 §3.6). It is the ONLY command the deploy key may run: the key's `authorized_keys` entry forces
# it, and it reads the request from SSH_ORIGINAL_COMMAND, which must be exactly `deploy <tag>`.
#
#   deploy <tag>     <tag> is a 12-hex-digit commit tag from the demo-image workflow. A moving tag
#                    such as `main` is refused: what runs must be a known, immutable build.
#
# It never runs unconfirmed: the deploy-demo workflow waits for the user's approval (GitHub environment
# `demo`) before it can reach this script.
set -euo pipefail
ROOT="${HOME}/edtp/implementation"
REGISTRY="ghcr.io/ssanchocanela/edtp-platform"
ALERTS="${HOME}/.edtp/alerts.env"
[ -f "$ALERTS" ] && . "$ALERTS"

request="${SSH_ORIGINAL_COMMAND:-$*}"
read -r verb tag extra <<<"$request" || true
say() { echo "deploy: $*"; logger -t edtp-deploy "$*"; }
notify() {
  [ -n "${ALERT_WEBHOOK_URL:-}" ] && curl -s -m 10 -o /dev/null -H "Title: EDTP demo" \
    -H "Priority: $1" -d "$2" "$ALERT_WEBHOOK_URL" || true
}
if [ "${verb:-}" != deploy ] || [ -n "${extra:-}" ] || ! [[ "${tag:-}" =~ ^[0-9a-f]{12}$ ]]; then
  say "refused: expected 'deploy <12-hex tag>'"
  exit 64
fi

cd "$HOME/edtp" && git pull -q --ff-only
cd "$ROOT"
C=(docker compose -f docker-compose.yml -f infra/demo-vm/docker-compose.demo.yml)
previous="$(sed -n 's/^EDTP_IMAGE=//p' .env)"
target="$REGISTRY:$tag"
if [ "$previous" = "$target" ]; then say "already on $tag"; exit 0; fi

say "pulling $tag"
docker pull -q "$target" >/dev/null

switch_to() {
  sed -i "s|^EDTP_IMAGE=.*|EDTP_IMAGE=$1|" .env
  "${C[@]}" up -d >/dev/null 2>&1
  for _ in $(seq 1 45); do
    [ "$("${C[@]}" ps platform-api --format '{{.Health}}')" = healthy ] && return 0
    sleep 2
  done
  return 1
}

if switch_to "$target" && infra/demo-vm/negative-checks.sh --local >/dev/null; then
  say "deployed $tag (was ${previous##*:}); local negative checks pass"
  echo "$(date -u +%FT%TZ) $tag ok" | sudo tee -a /var/lib/edtp-status/deploys.log >/dev/null
  notify default "EDTP demo: deployed $tag."
  exit 0
fi

say "deploy of $tag FAILED its checks; rolling back to ${previous##*:}"
switch_to "$previous" || true
if infra/demo-vm/negative-checks.sh --local >/dev/null; then
  notify high "EDTP demo: deploy of $tag failed its checks and was rolled back to ${previous##*:}."
else
  sudo systemctl stop cloudflared
  notify urgent "EDTP demo: deploy of $tag failed AND the rollback failed its checks. Tunnel stopped."
fi
echo "$(date -u +%FT%TZ) $tag rolled-back" | sudo tee -a /var/lib/edtp-status/deploys.log >/dev/null
exit 1
