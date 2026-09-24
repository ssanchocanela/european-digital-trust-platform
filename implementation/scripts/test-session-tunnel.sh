#!/usr/bin/env bash
#
# Opens a test session: the filtering gateway, three Cloudflare quick tunnels, and the negative checks
# that must pass before a wallet touches anything.
#
#   ./scripts/test-session-tunnel.sh up      start everything and print the environment to set
#   ./scripts/test-session-tunnel.sh check   re-run the negative checks against the public hostnames
#   ./scripts/test-session-tunnel.sh down    close the tunnels and stop the gateway
#
# ## What this exposes, and what it does not
#
# Three public hostnames: the engine's **wallet-facing paths only**, the platform's **single** same-device
# return route, and the start page. Everything else answers 404 — including the engine's Management API,
# which lives under `/api` on the same port and would otherwise be published by a quick tunnel
# (`CLAUDE.md` §6.20).
#
# The filtering is done by `apps/test-gateway`, not by the tunnel: a quick tunnel needs no account and
# no domain, and in exchange forwards every path on its hostname to one port. Path-level ingress rules
# need a named tunnel, an account and a domain.
#
# ## Rules
#
# Up only during a test session. Synthetic data only. Never left running.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${EDTP_SESSION_DIR:-${TMPDIR:-/tmp}/edtp-test-session}"
CLOUDFLARED="${CLOUDFLARED:-cloudflared}"

# A named tunnel with stable hostnames, when one is configured. Quick tunnels get a new hostname every
# session, and the engine writes its public URL into every attestation it issues — the status list
# URI — so an attestation issued in one session could not be verified in the next: the verifier's
# status fetch hit a hostname that no longer existed (530), and on 23 September 2026 that failed the
# first Power of X verification. A named tunnel keeps the hostnames, so a status list stays reachable
# whenever a session is open. The tunnel still runs only during a session; between sessions its
# hostnames answer Cloudflare's 1033 and expose nothing.
NAMED_ENV="${EDTP_NAMED_TUNNEL_ENV:-$HOME/.edtp/named-tunnel.env}"
if [ -f "$NAMED_ENV" ]; then
  # shellcheck disable=SC1090
  set -a; . "$NAMED_ENV"; set +a
fi

die() { echo "test-session: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

command -v "$CLOUDFLARED" >/dev/null 2>&1 ||
  die "cloudflared not found. Install it, or set CLOUDFLARED to its path."

# Does a name actually resolve?
#
# `host` is the obvious tool and is not installed everywhere — it comes from bind9-dnsutils, which a
# minimal Ubuntu does not carry. `getent hosts` asks the same resolver through NSS and is part of
# glibc, so it is always there. Both are tried rather than one assumed, because this check is the
# reason a registered-but-unresolvable tunnel is retried instead of waited out.
resolves() {
  if command -v host >/dev/null 2>&1; then
    host "$1" >/dev/null 2>&1
  else
    getent hosts "$1" >/dev/null 2>&1
  fi
}

start_tunnel() {
  # $1 label, $2 local port. Writes the public hostname to $RUN_DIR/$1.host.
  #
  # Retried, because a quick tunnel can register successfully and still be handed a hostname that never
  # appears in DNS. That happened on the first run of this script: cloudflared logged
  # "Registered tunnel connection", and the name it printed answered NXDOMAIN for as long as it was
  # left alone. Restarting the tunnel produced a working one immediately. So a name that does not
  # resolve is treated as a failed attempt rather than as something to wait out.
  local label="$1" port="$2"
  local attempt=1

  while [ "$attempt" -le 3 ]; do
    local log="$RUN_DIR/$label.log"
    : > "$log"
    # `--config` names an empty file on purpose. Without it cloudflared reads
    # ~/.cloudflared/config.yml, and a named tunnel's ingress there — another project's, on
    # 23 September 2026 — ends in `http_status:404`, which then answers every request to this quick
    # tunnel with a bare 404 from the edge. The tunnel registers, the name resolves, nothing reaches
    # the gateway, and nothing in the logs says why.
    : > "$RUN_DIR/cloudflared-empty.yml"
    "$CLOUDFLARED" tunnel --config "$RUN_DIR/cloudflared-empty.yml" --no-autoupdate \
      --url "http://127.0.0.1:$port" > "$log" 2>&1 &
    echo $! > "$RUN_DIR/$label.pid"

    # cloudflared prints the assigned hostname once the tunnel is registered. Polling the log is the
    # only way to learn it for a quick tunnel — there is no API and no fixed name.
    local waited=0 host=""
    while [ "$waited" -lt 30 ]; do
      host="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)"
      [ -n "$host" ] && break
      sleep 1
      waited=$((waited + 1))
    done

    # Wait BEFORE the first lookup, and then probe over HTTPS rather than asking DNS again.
    #
    # A fresh quick-tunnel hostname takes a few seconds to publish — about 18 on 13 September 2026.
    # Asking before then does more than fail: under WSL2 the resolver is the Windows host's DNS
    # proxy (/etc/resolv.conf points at 10.255.255.254), and Windows caches NXDOMAIN for minutes.
    # So one premature lookup poisons the cache and every later attempt on that name fails from the
    # cache rather than from DNS — which is exactly how three good tunnels in a row were discarded,
    # each after 45s of polling that could never have succeeded.
    #
    # The probe is an HTTP request because it answers the question that actually matters — can
    # anything reach this tunnel — and the gateway's default-deny replies 404 to `/`, so any HTTP
    # status at all proves the path end to end. `000` means no connection.
    if [ -n "$host" ]; then
      sleep "${TUNNEL_DNS_DELAY:-25}"
      local probe_waited=0 code="000"
      while [ "$probe_waited" -lt 60 ]; do
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$host/" || true)"
        [ "$code" != "000" ] && break
        sleep 5
        probe_waited=$((probe_waited + 5))
      done
      if [ "$code" != "000" ]; then
        echo "$host" > "$RUN_DIR/$label.host"
        echo "    $label → $host  (reachable, $code on /)"
        return 0
      fi
      echo "    $label: ${host#https://} not reachable after $((25 + probe_waited))s; retrying (attempt $attempt)" >&2
      kill "$(cat "$RUN_DIR/$label.pid")" 2>/dev/null || true
      attempt=$((attempt + 1))
      sleep 2
      continue
    fi

    if [ -n "$host" ] && resolves "${host#https://}"; then
      echo "$host" > "$RUN_DIR/$label.host"
      echo "    $label → $host"
      return 0
    fi

    if [ -n "$host" ]; then
      echo "    $label: ${host#https://} does not resolve; retrying (attempt $attempt)" >&2
    else
      echo "    $label: no hostname after ${waited}s; retrying (attempt $attempt)" >&2
    fi
    kill "$(cat "$RUN_DIR/$label.pid")" 2>/dev/null || true
    attempt=$((attempt + 1))
    sleep 2
  done

  echo "    $label: gave up after 3 attempts. Last lines:" >&2
  tail -5 "$RUN_DIR/$label.log" >&2
  return 1
}

# A quick tunnel is not serving the instant it prints a hostname: Cloudflare answers 000, 502 or 530
# for a few seconds while the edge picks it up. Running the negative checks into that window fails
# them all and reports "something is reachable that must not be", which is the opposite of what
# happened — and a security check that cries wolf is a security check people learn to skip.
#
# So wait for the tunnel to serve *something* first. Any HTTP status will do, including the 404 the
# allow-list gives an unknown path: the point is that the edge is answering, not what it says.
await_tunnel() {
  local host="$1" label="$2"
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$host/" || true)"
    case "$code" in
      000|502|503|504|530) sleep 2 ;;
      *) return 0 ;;
    esac
  done
  echo "    $label did not start answering within a minute." >&2
  return 1
}

negative_checks() {
  local engine="$1" platform="$2" failures=0
  await_tunnel "$engine" "engine tunnel" || return 1
  await_tunnel "$platform" "platform tunnel" || return 1

  # Every one of these MUST be 404. A 401 is not reassurance: it proves the endpoint is reachable.
  local engine_paths=(/api/docs-json /api/tenant /api/key-chain /api/verifier/config /api/oauth2/token /health /storage/x /docs /docs-json /)
  local platform_paths=(/v1/tenants /v1/presentations /health /openapi)
  # The hosted form serves itself and two images; nothing of the platform or the engine behind it.
  local form_paths=(/v1/hosted-forms /v1/hosted-verifications /v1/tenants /internal/engine/pid-1/attributes /api/tenant /health)

  # Each path is retried once on a transport-level failure, and only on that: a 200 or a 401 is an
  # answer and is a failure on the first try. Retrying a real answer would be how a reachable
  # endpoint gets waved through.
  probe() {
    local url="$1" code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url" || true)"
    if [ "$code" = "000" ]; then
      sleep 2
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url" || true)"
    fi
    printf '%s' "$code"
  }

  for path in "${engine_paths[@]}"; do
    code="$(probe "$engine$path")"
    printf '    %s  %s%s\n' "$code" "engine" "$path"
    [ "$code" = "404" ] || failures=$((failures + 1))
  done
  for path in "${platform_paths[@]}"; do
    code="$(probe "$platform$path")"
    printf '    %s  %s%s\n' "$code" "platform" "$path"
    [ "$code" = "404" ] || failures=$((failures + 1))
  done
  if [ -f "$RUN_DIR/form.host" ]; then
    local form
    form="$(cat "$RUN_DIR/form.host")"
    if ! await_tunnel "$form" "form host"; then
      echo "    000  form (not answering: is the pid-form container up?)"
      return 1
    fi
    for path in "${form_paths[@]}"; do
      code="$(probe "$form$path")"
      printf '    %s  %s%s\n' "$code" "form" "$path"
      [ "$code" = "404" ] || failures=$((failures + 1))
    done
  fi
  # The demonstration bank: a public page holding one narrow secret. Nothing of the platform's may be
  # reachable through it — the same probes as the form's.
  if [ -f "$RUN_DIR/bank.host" ]; then
    local bank
    bank="$(cat "$RUN_DIR/bank.host")"
    if ! await_tunnel "$bank" "bank host"; then
      echo "    000  bank (not answering: is the demo-bank container up?)"
      return 1
    fi
    for path in "${form_paths[@]}"; do
      code="$(probe "$bank$path")"
      printf '    %s  %s%s\n' "$code" "bank" "$path"
      [ "$code" = "404" ] || failures=$((failures + 1))
    done
  fi
  return "$failures"
}

case "${1:-up}" in
  up)
    mkdir -p "$RUN_DIR"
    chmod 700 "$RUN_DIR"

    step "Starting the filtering gateway"
    if ! curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${GATEWAY_ENGINE_PORT:-3010}/" ; then
      # "From list" reads issuer metadata the pinned wallet's parser refuses unless the gateway adds
      # key_attestations_required (interop-findings.md A29 item 3). A form session without the compat
      # switch fails at the list, with a message that points nowhere near the cause — so refuse it.
      if [ -n "${EDTP_FORM_TENANTS:-}" ] && [ "${GATEWAY_PINNED_WALLET_COMPAT:-false}" != "true" ]; then
        die "EDTP_FORM_TENANTS is set but GATEWAY_PINNED_WALLET_COMPAT is not true: the wallet's issuer
    list would fail on key_attestations_required (A29). Re-run with GATEWAY_PINNED_WALLET_COMPAT=true."
      fi
      # The hosted-form gate, when a form host is configured. The pass secret is read from .env and
      # handed to the gateway alone; it never reaches the form process.
      if [ -n "${EDTP_FORM_HOST:-}" ] && [ -f "$HERE/.env" ]; then
        GATEWAY_HOSTED_FORM_AUTHORIZE_SECRET="$(sed -n 's/^HOSTED_FORM_AUTHORIZE_SECRET=//p' "$HERE/.env" | tail -1)"
        if [ -n "$GATEWAY_HOSTED_FORM_AUTHORIZE_SECRET" ]; then
          export GATEWAY_HOSTED_FORM_AUTHORIZE_SECRET
          export GATEWAY_HOSTED_FORM_URL="$EDTP_FORM_HOST/"
          export GATEWAY_HOSTED_FORM_TENANTS="${EDTP_FORM_TENANTS:-}"
          echo "    hosted-form gate on for: ${EDTP_FORM_TENANTS:-<none>}"
        fi
      fi
      # With the demo compatibility switch on, also absorb a phone clock a few seconds fast (A29).
      if [ "${GATEWAY_PINNED_WALLET_COMPAT:-false}" = "true" ]; then
        export GATEWAY_ATTESTATION_SKEW_DELAY_MS="${GATEWAY_ATTESTATION_SKEW_DELAY_MS:-3000}"
      fi
      node "$HERE/apps/test-gateway/dist/main.js" > "$RUN_DIR/gateway.log" 2>&1 &
      echo $! > "$RUN_DIR/gateway.pid"
      sleep 2
    fi
    grep -q "listening" "$RUN_DIR/gateway.log" 2>/dev/null && echo "    gateway up" || true

    if [ -n "${EDTP_NAMED_TUNNEL:-}" ]; then
      step "Opening the named tunnel $EDTP_NAMED_TUNNEL"
      [ -f "${EDTP_NAMED_TUNNEL_CONFIG:-}" ] || die "EDTP_NAMED_TUNNEL_CONFIG does not name a file."
      # The ingress — which hostname reaches which local port — lives in that config, and the engine's
      # hostname must reach the gateway, never the engine's own port. The negative checks below are
      # what prove it does.
      "$CLOUDFLARED" tunnel --config "$EDTP_NAMED_TUNNEL_CONFIG" --no-autoupdate \
        run "$EDTP_NAMED_TUNNEL" > "$RUN_DIR/named.log" 2>&1 &
      echo $! > "$RUN_DIR/named.pid"
      echo "$EDTP_ENGINE_HOST" > "$RUN_DIR/engine.host"
      echo "$EDTP_PLATFORM_HOST" > "$RUN_DIR/platform.host"
      echo "$EDTP_START_HOST" > "$RUN_DIR/start.host"
      [ -n "${EDTP_FORM_HOST:-}" ] && echo "$EDTP_FORM_HOST" > "$RUN_DIR/form.host"
      [ -n "${EDTP_BANK_HOST:-}" ] && echo "$EDTP_BANK_HOST" > "$RUN_DIR/bank.host"
      echo "    engine → $EDTP_ENGINE_HOST, platform → $EDTP_PLATFORM_HOST, start → $EDTP_START_HOST"
    else
      step "Opening tunnels"
      start_tunnel engine "${GATEWAY_ENGINE_PORT:-3010}" || die "engine tunnel failed"
      start_tunnel platform "${GATEWAY_PLATFORM_PORT:-3011}" || die "platform tunnel failed"
      start_tunnel start "${TEST_START_PORT:-3201}" || die "start-page tunnel failed"
    fi

    ENGINE_HOST="$(cat "$RUN_DIR/engine.host")"
    PLATFORM_HOST="$(cat "$RUN_DIR/platform.host")"
    START_HOST="$(cat "$RUN_DIR/start.host")"

    step "Negative checks — every one must be 404"
    if ! negative_checks "$ENGINE_HOST" "$PLATFORM_HOST" | tee "$RUN_DIR/negative-checks.log"; then
      # Close first, explain second. A failed check can mean something is published that must not be,
      # and until 23 September 2026 this path exited with the tunnels still up.
      for name in engine platform start named; do
        [ -f "$RUN_DIR/$name.pid" ] && kill "$(cat "$RUN_DIR/$name.pid")" 2>/dev/null || true
        rm -f "$RUN_DIR/$name.pid"
      done
      # Only an answer other than 404 means exposure. 000 means nothing answered at all.
      if ! grep -qvE '^\s+(404|000) ' "$RUN_DIR/negative-checks.log"; then
        die "NEGATIVE CHECKS COULD NOT RUN: something did not answer (000). Tunnels closed. Usually DNS
    — a new hostname can be cached as nonexistent for the zone's negative TTL — or a stopped container
    behind a host. Nothing was found exposed."
      fi
      die "NEGATIVE CHECKS FAILED. Something is reachable that must not be. Tunnels closed. Do not start
    a wallet test; fix the allow-list in apps/test-gateway/src/allow-list.ts."
    fi
    echo "    all refused"

    cat > "$RUN_DIR/session.env" <<EOF
# Written by scripts/test-session-tunnel.sh. Source this BEFORE 'docker compose up'.
#
# The engine bakes these into every wallet-facing URL it emits, so setting them after a session exists
# produces a request a phone cannot fetch — and the symptom looks like a wallet problem.
ENGINE_PUBLIC_URL=$ENGINE_HOST
PLATFORM_PUBLIC_URL=$PLATFORM_HOST
TEST_START_PUBLIC_URL=$START_HOST
EOF

    cat <<EOF

================================ test session open ================================
 engine     $ENGINE_HOST   (wallet-facing paths only)
 platform   $PLATFORM_HOST   (one route: the same-device return page)
 start page $START_HOST

 Written to $RUN_DIR/session.env

 NEXT, and the order matters:
   set -a; . $RUN_DIR/session.env; set +a
   docker compose up -d --force-recreate eudiplo platform-api
   # then restart the console and the start page with the same variables

 Synthetic data only. Close it with: $0 down
===================================================================================

EOF
    ;;

  check)
    [ -f "$RUN_DIR/engine.host" ] || die "no session is open."
    step "Negative checks"
    negative_checks "$(cat "$RUN_DIR/engine.host")" "$(cat "$RUN_DIR/platform.host")" &&
      echo "    all refused" || die "SOMETHING IS REACHABLE THAT MUST NOT BE."
    ;;

  down)
    step "Closing the session"
    for name in engine platform start form named gateway; do
      if [ -f "$RUN_DIR/$name.pid" ]; then
        kill "$(cat "$RUN_DIR/$name.pid")" 2>/dev/null && echo "    stopped $name" || true
        rm -f "$RUN_DIR/$name.pid" "$RUN_DIR/$name.host"
      fi
      rm -f "$RUN_DIR/$name.host"
    done
    rm -f "$RUN_DIR/session.env"

    # `up` tolerates a gateway that was already listening and does not adopt it, so `down` has no pid
    # for one it did not start. That is the right behaviour — it must not kill someone else's process —
    # but printing "closed" while a component is still up is not, so it is reported.
    #
    # Nothing is publicly exposed either way: the gateway binds to loopback and the tunnels are gone.
    if curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${GATEWAY_ENGINE_PORT:-3010}/" 2>/dev/null; then
      echo "    NOTE: a gateway this script did not start is still listening on" \
           "127.0.0.1:${GATEWAY_ENGINE_PORT:-3010}. Loopback only, so nothing is exposed — stop it with"
      echo "          pkill -f 'test-gateway/dist/main.js'"
    fi

    step "Tunnels closed. Two things before the next run"
    echo "    - Reset ENGINE_PUBLIC_URL, PLATFORM_PUBLIC_URL and TEST_START_PUBLIC_URL before starting"
    echo "      the stack locally again, or the engine keeps emitting a hostname that no longer resolves."
    if [ -n "${EDTP_NAMED_TUNNEL:-}" ]; then
      echo "    - The named tunnel keeps its hostnames; attestations issued through it stay verifiable"
      echo "      in the next session."
    else
      echo "    - A closed quick tunnel's hostname is gone for good; the next session gets new ones, and"
      echo "      attestations issued in this one can no longer have their status checked."
    fi
    ;;

  *)
    die "usage: $0 [up|check|down]"
    ;;
esac
