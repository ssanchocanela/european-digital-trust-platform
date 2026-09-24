#!/usr/bin/env bash
# Applies a branding-profile request left by the portal's operator page (ADR 0010 §2). Started by the
# edtp-profile-request path unit when /var/lib/edtp-profile-requests/request.json appears.
#
# The portal is not trusted to have validated anything: the profile must be one of profiles/*.env, and
# the requester must look like an e-mail address (the Cloudflare Access identity). The request is
# consumed, whatever the outcome, and the result goes to last.json, which the operator page shows.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR=/var/lib/edtp-profile-requests
REQ="$DIR/request.json"
[ -f "$REQ" ] || exit 0
mv "$REQ" "$DIR/processing.json"

read -r profile by <<<"$(python3 - "$DIR/processing.json" <<'PY'
import json, re, sys
try:
    d = json.load(open(sys.argv[1]))
    p, b = str(d.get("profile", "")), str(d.get("by", ""))
except Exception:
    p, b = "", ""
ok = re.fullmatch(r"[a-z0-9-]{1,40}", p) and re.fullmatch(r"[^@\s]{1,64}@[^@\s]{1,190}", b)
print(p if ok else "-", b if ok else "-")
PY
)"
at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
result() {
  printf '{"profile":"%s","by":"%s","at":"%s","ok":%s}\n' "$profile" "$by" "$at" "$1" > "$DIR/last.json"
  rm -f "$DIR/processing.json"
}
if [ "$profile" = - ] || [ ! -f "$HERE/profiles/$profile.env" ]; then
  logger -t edtp-profile -p user.warning "request refused: invalid profile or requester"
  profile="${profile:-?}"; result false; exit 1
fi
if EDTP_PROFILE_REQUESTED_BY="$by" "$HERE/demo-profile.sh" "$profile"; then
  result true
else
  result false; exit 1
fi
