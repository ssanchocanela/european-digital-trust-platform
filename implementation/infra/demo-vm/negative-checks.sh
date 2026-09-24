#!/usr/bin/env bash
# Negative checks for the demonstration environment (ADR 0010). Every probe MUST be 404: a 200, 401 or
# 403 means something is reachable that must not be — a 401 is proof the endpoint is exposed, not
# reassurance. The same path lists as scripts/test-session-tunnel.sh.
#
#   ./infra/demo-vm/negative-checks.sh              the public hostnames, resolved over DoH
#   ./infra/demo-vm/negative-checks.sh --local      the VM's loopback ports, before any DNS moves
#
# Exit status: 0 all 404; 1 something answered otherwise; 2 something did not answer at all.
set -uo pipefail
if [ "${1:-}" = "--local" ]; then
  ENGINE=http://127.0.0.1:3010 PLATFORM=http://127.0.0.1:3011 FORM=http://127.0.0.1:3202 BANK=http://127.0.0.1:3203
  PORTAL=http://127.0.0.1:3204
  CURL=(curl)
else
  ENGINE=https://edtp-engine.murcata.es PLATFORM=https://edtp-platform.murcata.es
  FORM=https://edtp-pid.murcata.es BANK=https://edtp-banco.murcata.es PORTAL=https://demo.murcata.es
  CURL=(curl --doh-url "${EDTP_PROBE_DOH:-https://cloudflare-dns.com/dns-query}")
fi
engine_paths=(/api/docs-json /api/tenant /api/key-chain /api/verifier/config /api/oauth2/token /health /storage/x /docs /docs-json /)
platform_paths=(/v1/tenants /v1/presentations /health /openapi)
page_paths=(/v1/hosted-forms /v1/hosted-verifications /v1/tenants /internal/engine/pid-1/attributes /api/tenant /health)

failures=0 silent=0
probe() { # <label> <base> <path...>
  local label="$1" base="$2"; shift 2
  for path in "$@"; do
    code="$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' --max-time 15 "$base$path" || true)"
    printf '    %s  %s%s\n' "$code" "$label" "$path"
    case "$code" in 404) ;; 000) silent=$((silent + 1)) ;; *) failures=$((failures + 1)) ;; esac
  done
}
probe engine "$ENGINE" "${engine_paths[@]}"
probe platform "$PLATFORM" "${platform_paths[@]}"
probe form "$FORM" "${page_paths[@]}"
probe bank "$BANK" "${page_paths[@]}"
# The portal holds no secret, but nothing of the platform's may be reachable through it either.
[ "${EDTP_CHECK_PORTAL:-1}" = 1 ] && probe portal "$PORTAL" "${page_paths[@]}"
total=$(( ${#engine_paths[@]} + ${#platform_paths[@]} + (2 + ${EDTP_CHECK_PORTAL:-1}) * ${#page_paths[@]} ))
if [ "$failures" -gt 0 ]; then echo "NEGATIVE CHECKS FAILED: $failures of $total answered other than 404."; exit 1; fi
if [ "$silent" -gt 0 ]; then echo "NEGATIVE CHECKS INCOMPLETE: $silent of $total did not answer."; exit 2; fi
echo "Negative checks passed: all $total are 404."
