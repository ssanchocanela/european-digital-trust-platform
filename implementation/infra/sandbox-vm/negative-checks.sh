#!/usr/bin/env bash
# Negative checks for the sandbox VM (ADR 0017), on the pattern of infra/demo-vm/negative-checks.sh.
#
#   ./infra/sandbox-vm/negative-checks.sh           the public hostnames, resolved over DoH
#   ./infra/sandbox-vm/negative-checks.sh --local   the VM's loopback ports
#
# 1. Through the gateway, every probe MUST be 404: the engine's Management API (CLAUDE.md §6.20), the
#    platform's business API and the sandbox's own /sandbox/v1, which only the portal may call. A 401
#    or 403 is proof the endpoint is reachable, not reassurance.
# 2. The portal MUST be locked: publicly, a redirect to the Cloudflare Access login; on loopback,
#    the portal's own 403 for a request without Access's identity header.
#
# Exit status: 0 all as required; 1 something answered otherwise; 2 something did not answer at all.
# A 5xx, a 429 or a failed connection counts as "did not answer", never as exposure (the demo VM
# learnt this on 24 September 2026, when a deployment's 502s stopped its tunnel).
set -uo pipefail
if [ "${1:-}" = "--local" ]; then
  LOCAL=1 ENGINE=http://127.0.0.1:3010 PLATFORM=http://127.0.0.1:3011 PORTAL=http://127.0.0.1:3300
  CURL=(curl)
else
  LOCAL=0 ENGINE=https://sandbox-engine.murcata.es PLATFORM=https://sandbox-platform.murcata.es
  PORTAL=https://sandbox.murcata.es
  CURL=(curl --doh-url "${EDTP_PROBE_DOH:-https://cloudflare-dns.com/dns-query}")
fi
engine_paths=(/api/docs-json /api/tenant /api/key-chain /api/verifier/config /api/oauth2/token /health
  /storage/x /docs /docs-json /)
platform_paths=(/v1/tenants /v1/presentations /v1/me /health /openapi /sandbox/v1/me
  /sandbox/v1/organisations /sandbox/v1/sign-in-attempts /sandbox/v1/access/enter
  /sandbox/public/../v1/tenants /internal/engine/x/attributes)
portal_paths=(/ /wallet /org/x /sign-in/return)

failures=0 silent=0 total=0
count() { # <code> <ok-pattern>
  case "$1" in
    000 | 429 | 5??) silent=$((silent + 1)) ;;
    *) [[ "$1" =~ $2 ]] || failures=$((failures + 1)) ;;
  esac
}
probe() { # <label> <base> <path...>: each must be 404
  local label="$1" base="$2"; shift 2
  for path in "$@"; do
    total=$((total + 1))
    code="$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' --path-as-is --max-time 15 "$base$path" || true)"
    printf '    %s  %s%s\n' "$code" "$label" "$path"
    count "$code" '^404$'
  done
}
locked() { # <path...>: the portal must not answer without Access
  for path in "$@"; do
    total=$((total + 1))
    if [ "$LOCAL" = 1 ]; then
      code="$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' --max-time 15 "$PORTAL$path" || true)"
      printf '    %s  portal%s (loopback, no Access header: must be 403)\n' "$code" "$path"
      count "$code" '^403$'
    else
      out="$("${CURL[@]}" -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 "$PORTAL$path" || true)"
      code="${out%% *}" location="${out#* }"
      printf '    %s  portal%s -> %s\n' "$code" "$path" "${location:-(none)}"
      if [[ "$code" =~ ^30[127]$ ]] && [[ "$location" =~ ^https://[a-z0-9-]+\.cloudflareaccess\.com/ ]]; then
        :
      else
        count "$code" '^$'
      fi
    fi
  done
}
probe engine "$ENGINE" "${engine_paths[@]}"
probe platform "$PLATFORM" "${platform_paths[@]}"
locked "${portal_paths[@]}"
if [ "$failures" -gt 0 ]; then echo "NEGATIVE CHECKS FAILED: $failures of $total answered other than required."; exit 1; fi
if [ "$silent" -gt 0 ]; then echo "NEGATIVE CHECKS INCOMPLETE: $silent of $total did not answer."; exit 2; fi
echo "Negative checks passed: all $total as required."
