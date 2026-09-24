#!/usr/bin/env bash
# The scheduled negative checks of the demonstration environment (ADR 0010 §3.2). Run by the
# edtp-negative-checks timer every 15 minutes, against the public hostnames.
#
# - All 404: recorded as passing.
# - Something answered other than 404: something that must never be reachable is. That is an
#   exposure, so this **fails closed**: it stops the tunnel, taking every demo hostname offline until a
#   person has looked. Recorded, logged at error priority, and alerted.
# - Something did not answer: an outage, not an exposure. Recorded and alerted; the tunnel stays up.
#
# The last result goes to /var/lib/edtp-status/checks.json, which the portal's operator view shows. If
# ~/.edtp/alerts.env sets ALERT_WEBHOOK_URL, a one-line message is POSTed there. The message contains no
# path, no address and no secret.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATUS_DIR=/var/lib/edtp-status
ALERTS="${HOME}/.edtp/alerts.env"
[ -f "$ALERTS" ] && . "$ALERTS"

output="$("$HERE/negative-checks.sh" 2>&1)"
code=$?
summary="$(printf '%s\n' "$output" | tail -1)"
at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
case "$code" in
  0) result=pass ;;
  1) result=exposed ;;
  *) result=unreachable ;;
esac

alert() {
  logger -t edtp-checks -p "$1" "$2"
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    curl -s -m 10 -o /dev/null -d "$2" "$ALERT_WEBHOOK_URL" || true
  fi
}

if [ "$result" = exposed ]; then
  sudo systemctl stop cloudflared
  alert user.err "EDTP demo: negative checks FAILED — tunnel stopped, every demo hostname is offline until reviewed. $summary"
elif [ "$result" = unreachable ]; then
  alert user.warning "EDTP demo: negative checks could not run (a host did not answer). $summary"
else
  logger -t edtp-checks "$summary"
fi

sudo install -d -m 755 "$STATUS_DIR"
printf '{"at":"%s","result":"%s","summary":"%s"}\n' "$at" "$result" "${summary//\"/\'}" |
  sudo tee "$STATUS_DIR/checks.json" >/dev/null
exit "$code"
