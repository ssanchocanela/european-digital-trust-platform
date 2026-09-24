#!/usr/bin/env bash
# The nightly reset of the demonstration environment (ADR 0010 §3.4). Run by the edtp-nightly timer.
#
# 1. Back to the generic branding profile, whatever was left on. It also cancels a pending revert.
# 2. Recreates the application containers. That clears their in-memory state: held claims, return
#    destinations, rate-limit windows. The databases and the engine are left alone: resetting them would
#    invalidate every credential already issued, whose status lists live there. Engine sessions are
#    purged by their own TTL, and the platform's derived results by retention.
# 3. Removes images no container uses, so the disk does not fill with old releases.
# 4. Runs the negative checks.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"
C=(docker compose -f docker-compose.yml -f infra/demo-vm/docker-compose.demo.yml)

ALERTS="${HOME}/.edtp/alerts.env"
[ -f "$ALERTS" ] && . "$ALERTS"
on_error() {
  logger -t edtp-nightly -p user.err "nightly reset FAILED at line $1"
  [ -n "${ALERT_WEBHOOK_URL:-}" ] && curl -s -m 10 -o /dev/null -H "Title: EDTP demo" \
    -H "Priority: high" -H "Tags: warning" -d "EDTP demo: nightly reset failed (line $1)." \
    "$ALERT_WEBHOOK_URL" || true
}
trap 'on_error $LINENO' ERR

logger -t edtp-nightly "nightly reset: start"
"$HERE/demo-profile.sh" generic
"${C[@]}" up -d --force-recreate operator-console test-start pid-form demo-bank demo-portal gateway >/dev/null 2>&1
docker image prune -af --filter "until=72h" >/dev/null 2>&1 || true
sleep 20
"$HERE/scheduled-checks.sh" || true
logger -t edtp-nightly "nightly reset: done ($(df -h / | awk 'NR==2 {print $5}') of disk used)"
