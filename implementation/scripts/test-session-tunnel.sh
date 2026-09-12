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

die() { echo "test-session: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

command -v "$CLOUDFLARED" >/dev/null 2>&1 ||
  die "cloudflared not found. Install it, or set CLOUDFLARED to its path."

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
    "$CLOUDFLARED" tunnel --no-autoupdate --url "http://127.0.0.1:$port" > "$log" 2>&1 &
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

    if [ -n "$host" ] && host "${host#https://}" >/dev/null 2>&1; then
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

negative_checks() {
  local engine="$1" platform="$2" failures=0
  # Every one of these MUST be 404. A 401 is not reassurance: it proves the endpoint is reachable.
  local engine_paths=(/api/docs-json /api/tenant /api/key-chain /api/verifier/config /api/oauth2/token /health /storage/x /docs /docs-json /)
  local platform_paths=(/v1/tenants /v1/presentations /health /openapi)

  for path in "${engine_paths[@]}"; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$engine$path" || echo 000)"
    printf '    %s  %s%s\n' "$code" "engine" "$path"
    [ "$code" = "404" ] || failures=$((failures + 1))
  done
  for path in "${platform_paths[@]}"; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$platform$path" || echo 000)"
    printf '    %s  %s%s\n' "$code" "platform" "$path"
    [ "$code" = "404" ] || failures=$((failures + 1))
  done
  return "$failures"
}

case "${1:-up}" in
  up)
    mkdir -p "$RUN_DIR"
    chmod 700 "$RUN_DIR"

    step "Starting the filtering gateway"
    if ! curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${GATEWAY_ENGINE_PORT:-3010}/" ; then
      node "$HERE/apps/test-gateway/dist/main.js" > "$RUN_DIR/gateway.log" 2>&1 &
      echo $! > "$RUN_DIR/gateway.pid"
      sleep 2
    fi
    grep -q "listening" "$RUN_DIR/gateway.log" 2>/dev/null && echo "    gateway up" || true

    step "Opening tunnels"
    start_tunnel engine "${GATEWAY_ENGINE_PORT:-3010}" || die "engine tunnel failed"
    start_tunnel platform "${GATEWAY_PLATFORM_PORT:-3011}" || die "platform tunnel failed"
    start_tunnel start "${TEST_START_PORT:-3201}" || die "start-page tunnel failed"

    ENGINE_HOST="$(cat "$RUN_DIR/engine.host")"
    PLATFORM_HOST="$(cat "$RUN_DIR/platform.host")"
    START_HOST="$(cat "$RUN_DIR/start.host")"

    step "Negative checks — every one must be 404"
    if ! negative_checks "$ENGINE_HOST" "$PLATFORM_HOST"; then
      die "NEGATIVE CHECKS FAILED. Something is reachable that must not be. Do not start a wallet test;
    run '$0 down' and fix the allow-list in apps/test-gateway/src/allow-list.ts."
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
    for name in engine platform start gateway; do
      if [ -f "$RUN_DIR/$name.pid" ]; then
        kill "$(cat "$RUN_DIR/$name.pid")" 2>/dev/null && echo "    stopped $name" || true
        rm -f "$RUN_DIR/$name.pid" "$RUN_DIR/$name.host"
      fi
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
    echo "    - A closed quick tunnel's hostname is gone for good; the next session gets new ones."
    ;;

  *)
    die "usage: $0 [up|check|down]"
    ;;
esac
