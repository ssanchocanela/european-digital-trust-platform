#!/usr/bin/env bash
# One command per step of a wallet test session, instead of the eight that were run by hand.
#
#   ./scripts/test-session.sh up                     open the tunnel and point the stack at it
#   ./scripts/test-session.sh present <policyId>     create a presentation and check it is sound
#   ./scripts/test-session.sh present <policyId> --wallet <package>   … and send it to a phone
#   ./scripts/test-session.sh status                 what is open, and what the engine is emitting
#   ./scripts/test-session.sh down                   close the tunnel and return the stack to local
#
# ## Why this exists
#
# The sequence was run three times by hand on 13 September 2026 and went wrong differently each
# time. Every check below is one of those mistakes:
#
#   * A presentation was scanned after it had expired, and the failure looked like a wallet problem.
#   * A presentation was created against the service holding the smoke test's **self-signed**
#     certificate rather than the one signed by the development CA, so the wallet refused it for the
#     right reason and an hour went into the wrong question.
#   * The identifier in the wallet-facing `request_uri` was mistaken for the engine session id, and
#     every query about the session returned 404.
#
# None of them was a hard problem. All of them were expensive because nothing checked.
#
# ## The two minutes
#
# A QR presentation lives 120 seconds, not the platform default of 300. That is the ADR 0009 cap
# (`QR_MAX_TRANSACTION_LIFETIME_SECONDS`), a deliberate choice against a captured URI staying usable
# — not a misconfiguration to be raised. It is why this script prints the remaining seconds, wakes
# the phone before sending, and refuses to send with under a minute left.
#
# ## What it deliberately does not do
#
# Reissue the access certificate. The engine uses `x509_hash`, where the `client_id` **is** the
# SHA-256 of the leaf, so the certificate's SAN is not what a wallet matches against the request
# URL — a certificate outlives any number of tunnel hostnames. It would matter under
# `x509_san_dns`, which the engine does not use here, and this comment is where to start if that
# changes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

RUN_DIR="${EDTP_SESSION_DIR:-${TMPDIR:-/tmp}/edtp-test-session}"
CREDENTIALS="${EDTP_SMOKE_CREDENTIALS:-$HOME/.edtp/smoke-credentials.json}"
DEV_CA_DIR="${EDTP_DEV_CA_DIR:-$HOME/.edtp/dev-access-ca}"
ADB="${ADB:-/mnt/c/platform-tools/adb.exe}"

die() { echo "test-session: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

for tool in curl jq docker; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required."
done

tenant_key() {
  [ -f "$CREDENTIALS" ] || die "no credentials at $CREDENTIALS. Run scripts/smoke-vaas.sh with
    SMOKE_CREDENTIALS_OUT set, or point EDTP_SMOKE_CREDENTIALS at a file that has them."
  jq -r .tenantApiKey "$CREDENTIALS"
}

case "${1:-}" in
  up)
    step "Opening the tunnel"
    ./scripts/test-session-tunnel.sh up

    [ -f "$RUN_DIR/session.env" ] || die "the tunnel did not write $RUN_DIR/session.env."

    step "Pointing the stack at it"
    # Before `docker compose up`, never after: the engine bakes these into every wallet-facing URL
    # it emits, so a session created under the old value is unreachable for the rest of its life.
    set -a; . "$RUN_DIR/session.env"; set +a
    docker compose up -d --force-recreate eudiplo platform-api operator-console test-start >/dev/null
    sleep 10

    local_public="$(docker compose logs eudiplo --tail=40 2>/dev/null |
      sed -n 's/.*Public URL: *//p' | tail -1 | tr -d '\r')"
    echo "    engine is emitting: ${local_public:-<unknown>}"
    case "$local_public" in
      https://*) ;;
      *) die "the engine is still emitting '$local_public'. Something did not pick up the
    environment, and any session created now will be unreachable from a phone." ;;
    esac

    health="$(curl -s --max-time 10 http://127.0.0.1:3100/health || echo '{}')"
    echo "    platform: $health"
    echo
    echo "Session open. Next: $0 present <policyId> [--wallet eu.europa.ec.euidi.edtptest3]"
    ;;

  present)
    POLICY="${2:-}"
    [ -n "$POLICY" ] || die "usage: $0 present <policyId> [--wallet <package>]"
    WALLET=""
    [ "${3:-}" = "--wallet" ] && WALLET="${4:-}"

    KEY="$(tenant_key)"
    RESPONSE="$(curl -sS -X POST http://127.0.0.1:3100/v1/presentations \
      -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
      -d "$(jq -n --arg p "$POLICY" '{policyId:$p, businessReference:"test-session", interactionType:"QR"}')")"

    ERR="$(echo "$RESPONSE" | jq -r '.error // empty')"
    [ -z "$ERR" ] || die "the platform refused: $(echo "$RESPONSE" | jq -c '{error,message}')"

    ID="$(echo "$RESPONSE" | jq -r .presentationId)"
    URI="$(echo "$RESPONSE" | jq -r '.interaction.uri')"
    EXPIRES="$(echo "$RESPONSE" | jq -r .expiresAt)"

    # --- the three checks ---------------------------------------------------------------
    REQUEST_URI="$(printf '%s' "$URI" | sed -n 's/.*request_uri=\([^&]*\).*/\1/p' |
      python3 -c 'import sys,urllib.parse; print(urllib.parse.unquote(sys.stdin.read().strip()))')"
    # Every problem is reported, not just the first. Two of the three wasted afternoons had both
    # faults at once, and fixing one only to be told about the other is how an hour goes.
    PROBLEMS=0
    case "$REQUEST_URI" in
      https://*) echo "    request_uri  https, public" ;;
      *)
        PROBLEMS=$((PROBLEMS + 1))
        echo "    request_uri  NOT public: $REQUEST_URI"
        echo "                 A phone cannot fetch that, and the wallet's error will not say so."
        echo "                 Run '$0 up' first, or check the stack was recreated after the tunnel."
        ;;
    esac

    CLIENT_ID="$(printf '%s' "$URI" | sed -n 's/.*client_id=\([^&]*\).*/\1/p' |
      python3 -c 'import sys,urllib.parse; print(urllib.parse.unquote(sys.stdin.read().strip()))')"
    if [ -f "$DEV_CA_DIR/access.crt" ]; then
      EXPECTED="x509_hash:$(openssl x509 -in "$DEV_CA_DIR/access.crt" -outform DER |
        openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')"
      if [ "$CLIENT_ID" = "$EXPECTED" ]; then
        echo "    certificate  the development CA's — a WD-3 wallet will trust this"
      else
        PROBLEMS=$((PROBLEMS + 1))
        echo "    certificate  NOT the development CA's."
        echo "                 got      $CLIENT_ID"
        echo "                 expected $EXPECTED"
        echo "                 A wallet will refuse this, and its message will say only that the"
        echo "                 relying party could not be verified. This policy belongs to a"
        echo "                 service whose instance holds a different certificate."
      fi
    fi

    # The first wasted afternoon: a presentation scanned after it had expired, whose failure on the
    # phone looked like a wallet problem. Unlocking a phone and framing a QR takes longer than the
    # remaining window sometimes allows, so say how long there is rather than only when it ends.
    LEFT="$(( $(date -u -d "$EXPIRES" +%s 2>/dev/null || echo 0) - $(date -u +%s) ))"
    if [ "$LEFT" -le 0 ]; then
      PROBLEMS=$((PROBLEMS + 1))
      echo "    expires      ALREADY EXPIRED at $EXPIRES"
      echo "                 The wallet will report a generic failure. Check the clock skew between"
      echo "                 this host and the engine container."
    elif [ "$LEFT" -lt 60 ]; then
      PROBLEMS=$((PROBLEMS + 1))
      echo "    expires      $EXPIRES — only ${LEFT}s left, not enough to reach a phone"
    else
      echo "    expires      $EXPIRES (${LEFT}s)"
    fi
    echo "    presentation $ID    <- the engine session id is NOT the one in request_uri"
    echo
    echo "$URI"

    if [ "$PROBLEMS" -gt 0 ]; then
      echo
      echo "$PROBLEMS problem(s) above. The presentation exists and its URI is printed, but a"
      echo "wallet test against it would fail for a reason that has nothing to do with what is"
      echo "being tested. Not sending it to a phone."
      exit 1
    fi

    if [ -n "$WALLET" ]; then
      [ -x "$ADB" ] || command -v "$ADB" >/dev/null 2>&1 || die "adb not found at $ADB."
      LOCKED="$("$ADB" shell dumpsys window 2>/dev/null | grep -o 'mDreamingLockscreen=true' || true)"
      if [ -n "$LOCKED" ]; then
        "$ADB" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
        echo
        echo "    The phone is LOCKED. Unlock it now — a request sent to a locked screen waits"
        echo "    where nobody can see it, and the presentation expires at $EXPIRES."
      fi
      "$ADB" shell am start -a android.intent.action.VIEW -d "'$URI'" "$WALLET" >/dev/null 2>&1 ||
        die "adb could not start $WALLET."
      echo "    sent to $WALLET"
    fi
    ;;

  status)
    if [ -f "$RUN_DIR/engine.host" ]; then
      echo "tunnel open:"
      for name in engine platform start; do
        [ -f "$RUN_DIR/$name.host" ] && printf '  %-9s %s\n' "$name" "$(cat "$RUN_DIR/$name.host")"
      done
    else
      echo "no tunnel open."
    fi
    echo "engine is emitting: $(docker compose logs eudiplo --tail=40 2>/dev/null |
      sed -n 's/.*Public URL: *//p' | tail -1 | tr -d '\r')"
    ;;

  down)
    step "Closing the tunnel"
    ./scripts/test-session-tunnel.sh down

    step "Returning the stack to local URLs"
    # Without this the engine keeps emitting a hostname that no longer resolves, and the next
    # local test fails for a reason that has nothing to do with what is being tested.
    docker compose up -d --force-recreate eudiplo platform-api operator-console test-start >/dev/null
    sleep 8
    echo "    engine is emitting: $(docker compose logs eudiplo --tail=40 2>/dev/null |
      sed -n 's/.*Public URL: *//p' | tail -1 | tr -d '\r')"
    ;;

  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
