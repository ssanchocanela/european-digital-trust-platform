#!/usr/bin/env bash
# Negative checks for the demonstration environment (ADR 0010). Every probe MUST be 404: a 200, 401 or
# 403 means something is reachable that must not be — a 401 is proof the endpoint is exposed, not
# reassurance. The same path lists as scripts/test-session-tunnel.sh.
#
#   ./infra/demo-vm/negative-checks.sh              the public hostnames, resolved over DoH
#   ./infra/demo-vm/negative-checks.sh --local      the VM's loopback ports, before any DNS moves
#
# Exit status: 0 all 404; 1 something answered otherwise; 2 something did not answer at all.
#
# What counts as "answered otherwise": a response from the service itself — 2xx, 3xx, or any 4xx but
# 404. A 5xx (including Cloudflare's 530 for a tunnel with no connector), a 429 from a rate limit and a
# failed connection prove nothing is reachable and are counted as "did not answer". On 24 September
# 2026 a scheduled run met a deployment restarting the containers, read their 502s as exposure, and
# stopped the tunnel.
set -uo pipefail
if [ "${1:-}" = "--local" ]; then
  ENGINE=http://127.0.0.1:3010 PLATFORM=http://127.0.0.1:3011 FORM=http://127.0.0.1:3202 BANK=http://127.0.0.1:3203
  PORTAL=http://127.0.0.1:3204
  LUMEN=http://127.0.0.1:3211 PLAZA=http://127.0.0.1:3212 AV_VERIFIER=
  # The issuer's haproxy, asked as the public host: its own rule is what is checked on loopback.
  AV_ISSUER=https://127.0.0.1:3220 ISSUER_CURL=(curl -k -H "Host: issuer-dev.murcata.es")
  CURL=(curl)
else
  ENGINE=https://edtp-engine.murcata.es PLATFORM=https://edtp-platform.murcata.es
  FORM=https://edtp-pid.murcata.es BANK=https://edtp-banco.murcata.es PORTAL=https://demo.murcata.es
  LUMEN=https://av-lumen.murcata.es PLAZA=https://av-plaza.murcata.es AV_VERIFIER=https://av-verifier.murcata.es
  CURL=(curl --doh-url "${EDTP_PROBE_DOH:-https://cloudflare-dns.com/dns-query}")
  AV_ISSUER=https://issuer-dev.murcata.es ISSUER_CURL=("${CURL[@]}")
fi
# The age verification demos (ADR 0011), once they are deployed: on the VM, once ~/.av/demos.env exists;
# anywhere, with EDTP_CHECK_AV=1. Probing hostnames that do not exist yet would read as "did not answer".
if [ -z "${EDTP_CHECK_AV:-}" ]; then EDTP_CHECK_AV=0; [ -f "$HOME/.av/demos.env" ] && EDTP_CHECK_AV=1; fi
# The issuer (ADR 0012), likewise: once ~/.av/issuer.env exists, or with EDTP_CHECK_AV_ISSUER=1.
if [ -z "${EDTP_CHECK_AV_ISSUER:-}" ]; then EDTP_CHECK_AV_ISSUER=0; [ -f "$HOME/.av/issuer.env" ] && EDTP_CHECK_AV_ISSUER=1; fi
engine_paths=(/api/docs-json /api/tenant /api/key-chain /api/verifier/config /api/oauth2/token /health /storage/x /docs /docs-json /)
platform_paths=(/v1/tenants /v1/presentations /health /openapi)
page_paths=(/v1/hosted-forms /v1/hosted-verifications /v1/tenants /internal/engine/pid-1/attributes /api/tenant /health)
# Of the verifier only three wallet paths are published; everything else must be a 404 at the edge. On
# loopback the verifier answers everything -- the filter is the tunnel's -- so it is probed publicly only.
av_verifier_paths=(/ /v1/sessions /v1/sessions/x /ui/presentations /utilities/validations/msoMdoc/deviceResponse
  /.well-known/jwks.json /actuator/health /swagger-ui /public/openapi.json /wallet/x)
# The demos with their presenter controls off, and nothing of the verifier's through them.
av_demo_paths=(/av/registro /v1/sessions /.well-known/jwks.json /actuator/health)
# Keycloak's admin console and API and the master realm: refused by haproxy on loopback and by the tunnel
# publicly. A 200 or a 401 here means somebody on the internet can try the admin password.
av_issuer_paths=(/idp/admin/master/console/ /idp/admin/realms /idp/realms/master/.well-known/openid-configuration
  /idp/realms/master/protocol/openid-connect/token /pid-issuer/av/internal/v1/offers)

failures=0 silent=0 total=0
probe() { # <label> <base> <path...>
  local label="$1" base="$2"; shift 2
  local -a curl_cmd=("${CURL[@]}")
  [ "$label" = av-issuer ] && curl_cmd=("${ISSUER_CURL[@]}")
  for path in "$@"; do
    total=$((total + 1))
    code="$("${curl_cmd[@]}" -s -o /dev/null -w '%{http_code}' --max-time 15 "$base$path" || true)"
    printf '    %s  %s%s\n' "$code" "$label" "$path"
    case "$code" in
      404) ;;
      000 | 429 | 5??) silent=$((silent + 1)) ;;
      *) failures=$((failures + 1)) ;;
    esac
  done
}
probe engine "$ENGINE" "${engine_paths[@]}"
probe platform "$PLATFORM" "${platform_paths[@]}"
probe form "$FORM" "${page_paths[@]}"
probe bank "$BANK" "${page_paths[@]}"
# The portal holds no secret, but nothing of the platform's may be reachable through it either.
[ "${EDTP_CHECK_PORTAL:-1}" = 1 ] && probe portal "$PORTAL" "${page_paths[@]}"
if [ "$EDTP_CHECK_AV" = 1 ]; then
  probe lumen "$LUMEN" "${av_demo_paths[@]}"
  probe plaza "$PLAZA" "${av_demo_paths[@]}"
  [ -n "$AV_VERIFIER" ] && probe av-verifier "$AV_VERIFIER" "${av_verifier_paths[@]}"
fi
[ "$EDTP_CHECK_AV_ISSUER" = 1 ] && probe av-issuer "$AV_ISSUER" "${av_issuer_paths[@]}"
if [ "$failures" -gt 0 ]; then echo "NEGATIVE CHECKS FAILED: $failures of $total answered other than 404."; exit 1; fi
if [ "$silent" -gt 0 ]; then echo "NEGATIVE CHECKS INCOMPLETE: $silent of $total did not answer."; exit 2; fi
echo "Negative checks passed: all $total are 404."
