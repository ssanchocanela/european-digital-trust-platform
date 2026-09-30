#!/usr/bin/env bash
# Deploys the age verification stacks at one image tag, and rolls back if they do not come up healthy or
# the negative checks fail. Reached only through deploy.sh (`deploy-av <tag>`), which holds the deployment
# lock and validated the tag.
#
# Two compose projects, both built from one commit of age_verification_platform and so one tag:
#
#   av-demos   the verifier, Lumen and Plaza (ADR 0011)             ~/.av/demos.env, always
#   av-issuer  the issuer, Keycloak, the status list, the wallet    ~/.av/issuer.env, once setup-issuer.sh
#              provider and haproxy (ADR 0012)                        has written it
#
# They move together, and if either fails both go back to where they were: a verifier and an issuer from
# different commits is a combination nobody tested. A project with nothing to go back to (its first
# deployment) is stopped instead, and its hostnames answer 502 at the edge rather than anything
# half-configured.
set -euo pipefail

TAG="${1:?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DEMOS_ENV="$HOME/.av/demos.env"
ISSUER_ENV="$HOME/.av/issuer.env"
ALERTS="${HOME}/.edtp/alerts.env"
[ -f "$ALERTS" ] && . "$ALERTS"
REGISTRY=ghcr.io/ssanchocanela

say() { echo "deploy-av: $*"; logger -t edtp-deploy "av: $*"; }
notify() {
  [ -n "${ALERT_WEBHOOK_URL:-}" ] && curl -s -m 10 -o /dev/null -H "Title: EDTP demo" \
    -H "Priority: $1" -d "$2" "$ALERT_WEBHOOK_URL" || true
}
[[ "$TAG" =~ ^[0-9a-f]{12}$ ]] || { say "refused: bad tag"; exit 64; }
[ -f "$DEMOS_ENV" ] || { say "refused: $DEMOS_ENV is missing; run infra/demo-vm/av/setup-pki.sh first"; exit 78; }
[ -f "$HOME/.av/pki/verifier.p12" ] || { say "refused: no TEST PKI in ~/.av/pki; run setup-pki.sh first"; exit 78; }

DEMOS=(docker compose -p av-demos -f "$ROOT/infra/demo-vm/av/docker-compose.yml" --env-file "$DEMOS_ENV")
ISSUER=(docker compose -p av-issuer -f "$ROOT/infra/demo-vm/av-issuer/docker-compose.yml" --env-file "$ISSUER_ENV")
with_issuer=0
[ -f "$ISSUER_ENV" ] && with_issuer=1

tag_of() { sed -n "s/^$2=//p" "$1"; }
set_tag() { # <env file> <variable> <tag>
  if grep -q "^$2=" "$1"; then sed -i "s|^$2=.*|$2=$3|" "$1"; else echo "$2=$3" >> "$1"; fi
}

previous_demos="$(tag_of "$DEMOS_ENV" AV_IMAGE_TAG)"
previous_issuer=""
[ "$with_issuer" = 1 ] && previous_issuer="$(tag_of "$ISSUER_ENV" AV_ISSUER_IMAGE_TAG)"
if [ "$previous_demos" = "$TAG" ] && { [ "$with_issuer" = 0 ] || [ "$previous_issuer" = "$TAG" ]; }; then
  say "already on $TAG"
  exit 0
fi

say "pulling $TAG"
images=(av-verifier av-demos)
[ "$with_issuer" = 1 ] && images+=(av-issuer av-issuer-keycloak av-issuer-status-list av-issuer-haproxy av-issuer-db av-issuer-tools)
for image in "${images[@]}"; do docker pull -q "$REGISTRY/$image:$TAG" >/dev/null; done

demos_healthy() {
  # The verifier's image cannot run a container healthcheck (no shell), so its health is read here.
  curl -fs -m 3 http://127.0.0.1:3210/actuator/health 2>/dev/null | grep -q '"status":"UP"' || return 1
  for service in lumen plaza; do
    [ "$("${DEMOS[@]}" ps "$service" --format '{{.Health}}' 2>/dev/null)" = healthy ] || return 1
  done
}
issuer_healthy() {
  # Up means reachable the way a wallet reaches it: the signed metadata, through haproxy, as the public host.
  [ "$(curl -sk -m 5 -o /dev/null -w '%{http_code}' -H 'Host: issuer-dev.murcata.es' \
    https://127.0.0.1:3220/pid-issuer/.well-known/openid-credential-issuer)" = 200 ] || return 1
  # And Keycloak configured: the one-shot keycloak-config ran to the end.
  [ "$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' av-issuer-keycloak-config-1 2>/dev/null)" = "exited 0" ]
}
wait_for() { # <check>
  for _ in $(seq 1 120); do "$1" && return 0; sleep 2; done
  return 1
}
up_demos() { set_tag "$DEMOS_ENV" AV_IMAGE_TAG "$1" && "${DEMOS[@]}" up -d >/dev/null 2>&1 && wait_for demos_healthy; }
up_issuer() { set_tag "$ISSUER_ENV" AV_ISSUER_IMAGE_TAG "$1" && "${ISSUER[@]}" up -d >/dev/null 2>&1 && wait_for issuer_healthy; }
checks() { EDTP_CHECK_AV=1 "$ROOT/infra/demo-vm/negative-checks.sh" --local >/dev/null; }

ok=1
up_demos "$TAG" || ok=0
if [ "$ok" = 1 ] && [ "$with_issuer" = 1 ]; then up_issuer "$TAG" || ok=0; fi
[ "$ok" = 1 ] && { checks || ok=0; }

if [ "$ok" = 1 ]; then
  what="demos"; [ "$with_issuer" = 1 ] && what="demos and issuer"
  say "deployed $TAG, $what (was demos ${previous_demos:-nothing}${previous_issuer:+, issuer $previous_issuer}); local negative checks pass"
  echo "$(date -u +%FT%TZ) av $TAG ok" | sudo tee -a /var/lib/edtp-status/deploys.log >/dev/null
  notify default "EDTP demo: age verification $what deployed at $TAG."
  exit 0
fi

say "deploy of $TAG FAILED; putting both projects back"
restore() { # <project name> <previous tag> <up function> <compose array name> <env file> <variable>
  local name="$1" previous="$2" up="$3" env="$5" var="$6"
  local -n compose="$4"
  if [ -z "$previous" ]; then
    "${compose[@]}" down >/dev/null 2>&1 || true
    set_tag "$env" "$var" ""
    say "$name stopped: it had nothing to go back to"
  elif "$up" "$previous"; then
    say "$name back on $previous"
  else
    "${compose[@]}" down >/dev/null 2>&1 || true
    say "$name FAILED to go back to $previous; stopped"
    return 1
  fi
}
restored=1
restore av-demos "$previous_demos" up_demos DEMOS "$DEMOS_ENV" AV_IMAGE_TAG || restored=0
if [ "$with_issuer" = 1 ]; then
  restore av-issuer "$previous_issuer" up_issuer ISSUER "$ISSUER_ENV" AV_ISSUER_IMAGE_TAG || restored=0
fi
issuer_note=""
[ "$with_issuer" = 1 ] && issuer_note=", issuer ${previous_issuer:-stopped}"
if [ "$restored" = 1 ] && checks; then
  notify high "EDTP demo: age verification at $TAG failed and was put back (demos ${previous_demos:-stopped}$issuer_note)."
else
  notify urgent "EDTP demo: age verification at $TAG failed AND putting it back failed; check av-demos and av-issuer."
fi
echo "$(date -u +%FT%TZ) av $TAG rolled-back" | sudo tee -a /var/lib/edtp-status/deploys.log >/dev/null
exit 1
