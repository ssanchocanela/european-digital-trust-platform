#!/usr/bin/env bash
# Switches the demonstration environment's branding profile (ADR 0010 §2). Runs ON the VM.
#
#   ~/edtp/implementation/infra/demo-vm/demo-profile.sh fnmt-corpme    a client demonstration
#   ~/edtp/implementation/infra/demo-vm/demo-profile.sh generic        back to the public default
#
# What it does:
# 1. Writes the profile's keys into .env. The profiles hold display configuration only, no secret.
# 2. Recreates platform-api, pid-form and the gateway, so they read it.
# 3. Re-provisions every hosted-form policy, which rewrites each issuer's display name and logo in the
#    engine's metadata.
# 4. Logs the switch to the system journal (`journalctl -t edtp-profile`).
# 5. For a client profile, schedules `generic` in 4 hours. The time is not configurable here: the
#    window is a decision, not a parameter. `generic` cancels any pending revert.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PROFILE="${1:?usage: demo-profile.sh <$(ls "$HERE/profiles" | sed 's/\.env$//' | paste -sd'|')>}"
FILE="$HERE/profiles/$PROFILE.env"
[ -f "$FILE" ] || { echo "no profile $PROFILE" >&2; exit 1; }
cd "$ROOT"
C=(docker compose -f docker-compose.yml -f infra/demo-vm/docker-compose.demo.yml)

python3 - "$FILE" <<'PY'
import sys
profile = {}
for line in open(sys.argv[1]):
    line = line.rstrip("\n")
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        profile[k] = v
lines, seen = [], set()
for line in open(".env").read().splitlines():
    k = line.split("=", 1)[0] if "=" in line and not line.startswith("#") else None
    if k in profile:
        lines.append(f"{k}={profile[k]}"); seen.add(k)
    else:
        lines.append(line)
lines += [f"{k}={v}" for k, v in profile.items() if k not in seen]
open(".env", "w").write("\n".join(lines) + "\n")
PY

"${C[@]}" up -d --force-recreate platform-api pid-form gateway >/dev/null 2>&1
for _ in $(seq 1 40); do
  [ "$("${C[@]}" ps platform-api --format '{{.Health}}')" = healthy ] && break
  sleep 2
done

KEY="$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.edtp/issuance-credentials.json")))["tenantApiKey"])')"
POLICIES="$(sed -n 's/^HOSTED_FORM_POLICIES=//p' .env | tr -d '"')"
for entry in ${POLICIES//,/ }; do
  tenant="${entry%%:*}"; rest="${entry#*:}"; policy="${rest%%:*}"
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $KEY" \
    "http://127.0.0.1:3100/v1/tenants/$tenant/issuance-policies/$policy/provision")"
  echo "    provisioned ${policy:0:8}: $code"
done

logger -t edtp-profile "profile=$PROFILE by=${EDTP_PROFILE_REQUESTED_BY:-${SUDO_USER:-$USER}}"
sudo systemctl stop edtp-profile-revert.timer edtp-profile-revert.service >/dev/null 2>&1 || true
if [ "$PROFILE" != generic ]; then
  sudo systemd-run --quiet --unit edtp-profile-revert --uid "$(id -u)" --on-active=4h \
    "$HERE/demo-profile.sh" generic
  echo "Profile $PROFILE on. Reverts to generic at $(date -d '+4 hours' '+%H:%M %Z')."
else
  echo "Profile generic on."
fi
