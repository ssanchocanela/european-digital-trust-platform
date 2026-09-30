#!/usr/bin/env bash
# Deploys the age verification demos (ADR 0011) at one image tag, and rolls back if they do not come up
# healthy or the negative checks fail. Reached only through deploy.sh (`deploy-av <tag>`), which holds
# the deployment lock and validated the tag.
#
# The first deployment has nothing to roll back to: if it fails, the project is stopped, and its
# hostnames answer 502 at the edge rather than anything half-configured.
set -euo pipefail

TAG="${1:?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
ENV_FILE="$HOME/.av/demos.env"
ALERTS="${HOME}/.edtp/alerts.env"
[ -f "$ALERTS" ] && . "$ALERTS"

say() { echo "deploy-av: $*"; logger -t edtp-deploy "av: $*"; }
notify() {
  [ -n "${ALERT_WEBHOOK_URL:-}" ] && curl -s -m 10 -o /dev/null -H "Title: EDTP demo" \
    -H "Priority: $1" -d "$2" "$ALERT_WEBHOOK_URL" || true
}
[[ "$TAG" =~ ^[0-9a-f]{12}$ ]] || { say "refused: bad tag"; exit 64; }
[ -f "$ENV_FILE" ] || { say "refused: $ENV_FILE is missing; run infra/demo-vm/av/setup-pki.sh first"; exit 78; }
[ -f "$HOME/.av/pki/verifier.p12" ] || { say "refused: no TEST PKI in ~/.av/pki; run setup-pki.sh first"; exit 78; }

C=(docker compose -p av-demos -f "$ROOT/infra/demo-vm/av/docker-compose.yml" --env-file "$ENV_FILE")
previous="$(sed -n 's/^AV_IMAGE_TAG=//p' "$ENV_FILE")"
if [ "$previous" = "$TAG" ]; then say "already on $TAG"; exit 0; fi

say "pulling $TAG"
docker pull -q "ghcr.io/ssanchocanela/av-verifier:$TAG" >/dev/null
docker pull -q "ghcr.io/ssanchocanela/av-demos:$TAG" >/dev/null

healthy() {
  for _ in $(seq 1 90); do
    local all=1
    for service in av-verifier lumen plaza; do
      [ "$("${C[@]}" ps "$service" --format '{{.Health}}' 2>/dev/null)" = healthy ] || all=0
    done
    [ "$all" = 1 ] && return 0
    sleep 2
  done
  return 1
}
switch_to() {
  if grep -q '^AV_IMAGE_TAG=' "$ENV_FILE"; then
    sed -i "s|^AV_IMAGE_TAG=.*|AV_IMAGE_TAG=$1|" "$ENV_FILE"
  else
    echo "AV_IMAGE_TAG=$1" >> "$ENV_FILE"
  fi
  "${C[@]}" up -d >/dev/null 2>&1 && healthy
}
checks() { EDTP_CHECK_AV=1 "$ROOT/infra/demo-vm/negative-checks.sh" --local >/dev/null; }

if switch_to "$TAG" && checks; then
  say "deployed $TAG (was ${previous:-nothing}); local negative checks pass"
  echo "$(date -u +%FT%TZ) av $TAG ok" | sudo tee -a /var/lib/edtp-status/deploys.log >/dev/null
  notify default "EDTP demo: age verification demos deployed at $TAG."
  exit 0
fi

if [ -z "$previous" ]; then
  say "first deployment of $TAG FAILED; stopping the av-demos project"
  "${C[@]}" down >/dev/null 2>&1 || true
  sed -i "s|^AV_IMAGE_TAG=.*|AV_IMAGE_TAG=|" "$ENV_FILE"
  notify high "EDTP demo: first deployment of the age verification demos ($TAG) failed; they are stopped."
else
  say "deploy of $TAG FAILED; rolling back to $previous"
  if switch_to "$previous" && checks; then
    notify high "EDTP demo: age verification demos at $TAG failed and were rolled back to $previous."
  else
    "${C[@]}" down >/dev/null 2>&1 || true
    notify urgent "EDTP demo: age verification demos at $TAG failed AND the rollback failed; they are stopped."
  fi
fi
echo "$(date -u +%FT%TZ) av $TAG rolled-back" | sudo tee -a /var/lib/edtp-status/deploys.log >/dev/null
exit 1
