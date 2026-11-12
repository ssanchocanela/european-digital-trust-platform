#!/usr/bin/env bash
# Deploys one published image to the sandbox VM, and rolls back if the negative checks fail
# (ADR 0017, on the pattern of infra/demo-vm/deploy.sh and ADR 0010 §3.6). It is the ONLY command the
# deploy key may run: the key's authorized_keys entry forces it, and it reads the request from
# SSH_ORIGINAL_COMMAND, which must be exactly `deploy <tag>`.
#
#   deploy <tag>   a 12-hex-digit commit tag from the demo-image workflow. A moving tag such as `main`
#                  is refused: what runs must be a known, immutable build.
#
# It never runs unconfirmed: the deploy-sandbox workflow waits for the user's approval (GitHub
# environment `sandbox`) before it can reach this script.
#
# Before switching, it takes a backup (nightly-backup.sh): the new image may carry a migration, and the
# sealed CA key store is the one thing a rebuild cannot recreate.
set -euo pipefail
ROOT="${HOME}/edtp/implementation"
REGISTRY="ghcr.io/ssanchocanela/edtp-platform"
ALERTS="${HOME}/.edtp/alerts.env"
[ -f "$ALERTS" ] && . "$ALERTS"

request="${SSH_ORIGINAL_COMMAND:-$*}"
read -r verb tag extra <<<"$request" || true
say() { echo "deploy: $*"; logger -t edtp-sandbox-deploy "$*"; }
notify() {
  [ -n "${ALERT_WEBHOOK_URL:-}" ] && curl -s -m 10 -o /dev/null -H "Title: EDTP sandbox" \
    -H "Priority: $1" -d "$2" "$ALERT_WEBHOOK_URL" || true
}
if [ "${verb:-}" != deploy ] || [ -n "${extra:-}" ] || ! [[ "${tag:-}" =~ ^[0-9a-f]{12}$ ]]; then
  say "refused: expected 'deploy <12-hex tag>'"
  exit 64
fi

# Held for the whole deployment: the scheduled checks and the nightly backup skip their turn.
exec 9>/tmp/edtp-deploy.lock
flock -w 120 9 || { say "refused: another deployment holds the lock"; exit 75; }

cd "$HOME/edtp" && git pull -q --ff-only
cd "$ROOT"
C=(docker compose -f infra/sandbox-vm/docker-compose.sandbox.yml --env-file .env)
previous="$(sed -n 's/^EDTP_IMAGE=//p' .env)"
target="$REGISTRY:$tag"
if [ "$previous" = "$target" ]; then say "already on $tag"; exit 0; fi

say "pulling $tag"
docker pull -q "$target" >/dev/null
EDTP_BACKUP_HOLDS_LOCK=1 infra/sandbox-vm/nightly-backup.sh "pre-deploy-$tag" >/dev/null ||
  { say "refused: the pre-deployment backup failed"; notify high "EDTP sandbox: deploy of $tag refused, backup failed."; exit 1; }

switch_to() {
  sed -i "s|^EDTP_IMAGE=.*|EDTP_IMAGE=$1|" .env
  "${C[@]}" up -d >/dev/null 2>&1
  for _ in $(seq 1 45); do
    [ "$("${C[@]}" ps platform-api --format '{{.Health}}')" = healthy ] && return 0
    sleep 2
  done
  return 1
}

if switch_to "$target" && infra/sandbox-vm/negative-checks.sh --local >/dev/null; then
  say "deployed $tag (was ${previous##*:}); local negative checks pass"
  echo "$(date -u +%FT%TZ) $tag ok" | sudo tee -a /var/lib/edtp-status/deploys.log >/dev/null
  notify default "EDTP sandbox: deployed $tag."
  exit 0
fi

# A migration the new image applied stays applied: the platform's migrations only add, so the
# previous image runs on the newer schema. If it does not, restore the pre-deployment backup by hand.
say "deploy of $tag FAILED its checks; rolling back to ${previous##*:}"
switch_to "$previous" || true
if infra/sandbox-vm/negative-checks.sh --local >/dev/null; then
  notify high "EDTP sandbox: deploy of $tag failed its checks and was rolled back to ${previous##*:}."
else
  sudo systemctl stop cloudflared
  notify urgent "EDTP sandbox: deploy of $tag failed AND the rollback failed its checks. Tunnel stopped."
fi
echo "$(date -u +%FT%TZ) $tag rolled-back" | sudo tee -a /var/lib/edtp-status/deploys.log >/dev/null
exit 1
