#!/usr/bin/env bash
# Drives one registration session at the EUDIW reference RP Registration Service, from the
# OID4VP login through to the PKCS#12 access certificate and the registration certificates.
#
#   ./scripts/register-relying-party.sh <entity.json>
#   ./scripts/register-relying-party.sh --login-only
#
# Why this exists as a script rather than a checklist: after the login the service's API is a
# chain of fourteen calls, each consuming integer identifiers minted by an earlier one, and it has
# no idempotency key and no way to amend a half-built registration. Doing it by hand means
# transcribing ids between terminal windows, and a mistake in the middle is not editable — it
# leaves an orphaned entity behind. So the ids are captured in a state file and each step is
# skipped if it already ran, which makes an interrupted session resumable instead of restartable.
#
# The route names and payload shapes here come from the service's own OpenAPI document
# (`/apispec_1.json`, title "My API" v1.0.0, read 12 September 2026), not from its `/guide` page
# and not from what our own earlier plan predicted — every route the plan guessed turned out not
# to exist. See docs/registration-session-plan.md §3 and docs/interop-findings.md C9.
#
# **Secrets.** `hash_pid` is the session credential for the whole registration and the PKCS#12
# passphrase protects the private key. Neither is ever a command-line argument — an argv is
# readable by any process through `ps` and lands in shell history — and neither is ever printed.
# `hash_pid` is written to a mode-600 file outside the repository so a session can be resumed;
# that path matches the `*hash_pid*` gitignore rule as well, but it is outside the tree on
# purpose. Nothing this script prints contains either value.
#
# This registers against a service that describes itself as non-production. Everything it
# produces is TEST trust material, per CLAUDE.md §7.
set -euo pipefail

BASE_URL="${BASE_URL:-https://registry.serviceproviders.eudiw.dev}"
OUT_DIR="${EDTP_REGISTRATION_DIR:-$HOME/.edtp/registration}"
STATE="${EDTP_REGISTRATION_STATE:-$OUT_DIR/state.json}"
HASH_PID_FILE="$OUT_DIR/hash_pid"
POLL_SECONDS="${POLL_SECONDS:-3}"
POLL_ATTEMPTS="${POLL_ATTEMPTS:-100}"

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required." >&2; exit 1; }
done

mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"
WORK=$(mktemp -d); chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

LOGIN_ONLY=no
CONFIG=""
case "${1:-}" in
  --login-only) LOGIN_ONLY=yes ;;
  "")           echo "usage: register-relying-party.sh <entity.json> | --login-only" >&2; exit 1 ;;
  *)            CONFIG="$1"; [ -r "$CONFIG" ] || { echo "cannot read $CONFIG" >&2; exit 1; }
                jq -e . "$CONFIG" >/dev/null || { echo "$CONFIG is not valid JSON" >&2; exit 1; } ;;
esac

# --- state ------------------------------------------------------------------------------
# Identifiers only. No secrets: hash_pid has its own mode-600 file and the P12 passphrase is
# never stored at all.

[ -f "$STATE" ] || echo '{}' > "$STATE"
chmod 600 "$STATE"

state_set() {
  local key="$1" value="$2" tmp
  tmp=$(mktemp -p "$WORK")
  jq --arg k "$key" --argjson v "$value" '.[$k] = $v' "$STATE" > "$tmp"
  mv "$tmp" "$STATE"; chmod 600 "$STATE"
}

# --- transport --------------------------------------------------------------------------
# `curl -f` is deliberately not used: the service reports validation failures with a JSON body
# that names the offending field, and that body is the only useful diagnostic. So the status
# code is captured separately and the body is shown when the call fails.

# EDTP_DRY_RUN=1 rehearses the whole chain without calling the service: every request body is
# built exactly as it would be sent, validated as JSON and printed with hash_pid redacted, and
# each step is answered with a synthetic id. Worth doing before the real session, because the
# login can only be spent once per presentation and a rejected body halfway through leaves an
# orphaned entity that cannot be edited away.
api_post() {
  local path="$1" body="$2" code
  if [ -n "${EDTP_DRY_RUN:-}" ]; then
    echo >&2
    echo "  DRY RUN  POST $path" >&2
    printf '%s' "$body" | jq '.hash_pid = "<redacted>" | if .password then .password = "<redacted>" else . end' >&2
    printf '{"data":[1],"message":"dry run","file_base64":""}'
    return 0
  fi
  code=$(printf '%s' "$body" \
    | curl -sS --max-time 60 -o "$WORK/body" -w '%{http_code}' \
        -X POST "$BASE_URL$path" -H 'Content-Type: application/json' --data-binary @-)
  if [ "$code" != "200" ] && [ "$code" != "201" ]; then
    echo >&2
    echo "POST $path failed with HTTP $code:" >&2
    # The request body is not echoed: it carries hash_pid.
    jq . "$WORK/body" >&2 2>/dev/null || cat "$WORK/body" >&2
    echo >&2
    return 1
  fi
  cat "$WORK/body"
}

api_get() {
  local path="$1" code
  code=$(curl -sS --max-time 60 -o "$WORK/body" -w '%{http_code}' "$BASE_URL$path")
  if [ "$code" != "200" ]; then
    echo >&2; echo "GET ${path%%\?*} failed with HTTP $code:" >&2
    jq . "$WORK/body" >&2 2>/dev/null || cat "$WORK/body" >&2
    echo >&2
    return 1
  fi
  cat "$WORK/body"
}

# Every creation endpoint answers `{"data": [<ids>], "message": "..."}`. A step records its
# whole id array, so a caller can take one id or all of them.
create_step() {
  local key="$1" path="$2" body="$3" existing ids
  existing=$(jq -c --arg k "$key" '.[$k] // empty' "$STATE")
  if [ -n "$existing" ]; then
    echo "  $key: already created ($existing) — skipping"
    return 0
  fi
  ids=$(api_post "$path" "$body" | jq -c '.data')
  [ "$ids" != "null" ] && [ -n "$ids" ] || { echo "$path returned no data array" >&2; return 1; }
  state_set "$key" "$ids"
  echo "  $key: $ids"
}

first_id() { jq -r --arg k "$1" '.[$k][0]' "$STATE"; }
all_ids()  { jq -c --arg k "$1" '.[$k]'    "$STATE"; }

# --- step 0: authenticate by PID presentation -------------------------------------------
# There are no accounts. The service authenticates by an OID4VP presentation of a PID, and the
# resulting hash_pid is the credential every later call carries. The wallet that presents it,
# and the PID inside it, must survive for as long as these registrations are to stay
# manageable — docs/certificate-intake-runbook.md says why, and it is not recoverable.

login() {
  local auth qr presentation_id attempt hp
  auth=$(api_get "/authentication")
  qr=$(printf '%s' "$auth" | jq -r '.QR_code_url')
  presentation_id=$(printf '%s' "$auth" | jq -r '.presentation_id')

  echo
  echo "Scan this with the wallet holding the test PID:"
  echo
  if command -v qrencode >/dev/null 2>&1; then
    qrencode -t ANSIUTF8 "$qr"
  else
    echo "  (install qrencode to render this as a QR code in the terminal)"
  fi
  echo
  echo "$qr"
  echo
  echo "Waiting for the presentation to complete."

  for attempt in $(seq 1 "$POLL_ATTEMPTS"); do
    if api_get "/pid_authorization?presentation_id=$presentation_id" >/dev/null 2>&1; then
      echo "  presentation accepted."
      break
    fi
    if [ "$attempt" -eq "$POLL_ATTEMPTS" ]; then
      echo "Timed out waiting for the PID presentation." >&2
      return 1
    fi
    sleep "$POLL_SECONDS"
  done

  # The response is a bare string in some builds and a JSON string in others, so accept both
  # and never echo the result.
  hp=$(api_post "/getpidoid4vp?presentation_id=$presentation_id" '{}' | jq -r 'if type == "string" then . else (.hash_pid // .data // empty) end')
  [ -n "$hp" ] || { echo "The service returned no hash_pid." >&2; return 1; }

  printf '%s' "$hp" > "$HASH_PID_FILE"
  chmod 600 "$HASH_PID_FILE"
  HASH_PID="$hp"
  echo "  hash_pid obtained and stored, mode 600, at $HASH_PID_FILE"
  echo "  It is a secret: do not paste it into a document, a log or a commit."
}

# A session is resumable: an existing hash_pid is reused rather than forcing a second
# presentation, because re-authenticating yields a different session.
if [ -n "${EDTP_DRY_RUN:-}" ] && [ -z "${HASH_PID:-}" ]; then
  # A rehearsal needs no wallet and must not spend a presentation.
  HASH_PID="dry-run-placeholder"
  echo "Dry run: no login, no calls to the service."
elif [ -n "${HASH_PID:-}" ]; then
  echo "Using hash_pid from the environment."
elif [ -s "$HASH_PID_FILE" ]; then
  HASH_PID=$(cat "$HASH_PID_FILE")
  echo "Using the hash_pid stored at $HASH_PID_FILE"
else
  login
fi

if [ "$LOGIN_ONLY" = yes ]; then
  echo
  echo "Login only, as asked. Re-run with an entity file to continue the registration."
  exit 0
fi

# --- the registration chain -------------------------------------------------------------
# Order is not a style choice: each call consumes ids minted by an earlier one, and the
# service rejects a reference it cannot resolve.

cfg() { jq -c --arg p "$1" 'getpath($p | split("."))' "$CONFIG"; }

echo
echo "Registering, against $BASE_URL"
echo

create_step law "/law/create" \
  "$(jq -n --arg hp "$HASH_PID" --argjson law "$(cfg law)" '{hash_pid: $hp, law: $law}')"

create_step legal_person "/legal_person/create" \
  "$(jq -n --arg hp "$HASH_PID" --argjson lp "$(cfg legalPerson)" --argjson law "$(all_ids law)" \
      '{hash_pid: $hp, legalPerson: [$lp + {law: $law}]}')"

create_step identifier "/identifier/create" \
  "$(jq -n --arg hp "$HASH_PID" --argjson ids "$(cfg identifiers)" '{hash_pid: $hp, identifier: $ids}')"

create_step legal_entity "/legal_entity/create" \
  "$(jq -n --arg hp "$HASH_PID" --argjson le "$(cfg legalEntity)" \
      --argjson idents "$(all_ids identifier)" --argjson lp "$(first_id legal_person)" \
      '{hash_pid: $hp, legal_entity: [$le + {identifiers: $idents, legal_person_id: $lp}]}')"

# Two policies, distinguished by `intention`. The provider takes the `wrp` one; the intended
# use takes the `intended_use` one as its privacy policy. Mixing them is rejected.
create_step policy_wrp "/policy/create" \
  "$(jq -n --arg hp "$HASH_PID" --argjson p "$(cfg policies.wrp)" \
      '{hash_pid: $hp, policy: [$p + {intention: "wrp"}]}')"

create_step provider "/provider/create" \
  "$(jq -n --arg hp "$HASH_PID" --argjson pr "$(cfg provider)" \
      --argjson le "$(first_id legal_entity)" --argjson pol "$(all_ids policy_wrp)" \
      '{hash_pid: $hp, provider: [$pr + {legalEntityId: $le, policy_id: $pol}]}')"

create_step credential "/credential/create" \
  "$(jq -n --arg hp "$HASH_PID" --argjson c "$(cfg credentials)" '{hash_pid: $hp, credentials: $c}')"

create_step policy_intended_use "/policy/create" \
  "$(jq -n --arg hp "$HASH_PID" --argjson p "$(cfg policies.intendedUse)" \
      '{hash_pid: $hp, policy: [$p + {intention: "intended_use"}]}')"

# `createdAt` and `revokedAt` are both mandatory here — the service requires an end date up
# front, so the entity file carries it rather than the script inventing one.
create_step intended_use "/intended_use/create" \
  "$(jq -n --arg hp "$HASH_PID" --argjson iu "$(cfg intendedUse)" \
      --argjson creds "$(all_ids credential)" --argjson pol "$(all_ids policy_intended_use)" \
      '{hash_pid: $hp, intended_uses: [$iu + {credential_ids: $creds, privacyPolicy_id: $pol}]}')"

create_step provided_attestation "/provided_attestation/create" \
  "$(jq -n --arg hp "$HASH_PID" --argjson pa "$(cfg providedAttestations)" \
      '{hash_pid: $hp, providesAttestations: $pa}')"

create_step supervisory_authority "/supervisory_authority/create" \
  "$(jq -n --arg hp "$HASH_PID" --argjson sa "$(cfg supervisoryAuthority)" \
      '{hash_pid: $hp, supervisoryAuthority: [$sa]}')"

# The Wallet Relying Party is where the two roles meet: one registration carrying both
# `Service_Provider` and `Non_Q_EAA_Provider` entitlements, which is how twenty entities in the
# live register are shaped. ARF §6.3.2.3 dual-role registration.
create_step wallet_rp "/wallet_rp/create" \
  "$(jq -n --arg hp "$HASH_PID" --argjson w "$(cfg walletRelyingParty)" \
      --argjson prov "$(first_id provider)" --argjson iu "$(all_ids intended_use)" \
      --argjson pa "$(all_ids provided_attestation)" --argjson sa "$(first_id supervisory_authority)" \
      '{hash_pid: $hp, WalletRelyingParty: [$w + {provider_id: $prov, intendedUse_ids: $iu,
        providesAttestations_id: $pa, supervisoryAuthority: $sa}]}')"

WRP_ID=$(first_id wallet_rp)
IU_ID=$(first_id intended_use)

# --- certificates -----------------------------------------------------------------------

echo
echo "Registration complete. Wallet Relying Party id $WRP_ID, intended use id $IU_ID."
echo

P12_OUT="$OUT_DIR/rpac.p12"
if [ -f "$P12_OUT" ]; then
  echo "$P12_OUT already exists — not overwriting. Move it aside to reissue."
else
  if [ -n "${P12_PASSWORD:-}" ]; then
    PASS="$P12_PASSWORD"
  else
    read -r -s -p "Choose a passphrase for the PKCS#12: " PASS; echo
    read -r -s -p "Again: " PASS_AGAIN; echo
    [ "$PASS" = "$PASS_AGAIN" ] || { echo "Passphrases differ." >&2; exit 1; }
  fi
  [ -n "$PASS" ] || { echo "An empty passphrase is not acceptable for a private key." >&2; exit 1; }

  # The passphrase goes into a JSON body over stdin, never into argv. The service chooses no
  # passphrase of its own: this one is what protects the private key from here on.
  CERT_RESPONSE=$(api_post "/wallet_rp/certificate" \
    "$(jq -n --arg hp "$HASH_PID" --argjson id "$WRP_ID" --arg pw "$PASS" \
        '{hash_pid: $hp, wrp_id: $id, password: $pw}')")
  unset PASS PASS_AGAIN

  if [ -n "${EDTP_DRY_RUN:-}" ]; then
    echo "  DRY RUN: no PKCS#12 written."
  else
    # The P12 arrives base64-encoded inside a JSON field rather than as a file download, so the
    # decode is checked: a missing field would otherwise leave a plausible-looking empty file
    # that only fails later, during the chain check, where it would look like a chain problem.
    B64=$(printf '%s' "$CERT_RESPONSE" | jq -r '.data.file_base64 // empty')
    [ -n "$B64" ] || {
      echo "The certificate response carried no data.file_base64:" >&2
      printf '%s' "$CERT_RESPONSE" | jq 'del(.data.file_base64)' >&2 2>/dev/null || true
      exit 1
    }
    printf '%s' "$B64" | base64 -d > "$P12_OUT"
    chmod 600 "$P12_OUT"
    [ -s "$P12_OUT" ] || { echo "The decoded PKCS#12 is empty." >&2; exit 1; }
    echo "Access certificate written to $P12_OUT (mode 600)."
  fi
fi

RC_OUT="$OUT_DIR/rprc-intended-use-$IU_ID.jwt"
if [ -f "$RC_OUT" ]; then
  echo "$RC_OUT already exists — not overwriting."
else
  # One registration certificate per intended use, not per service: the API is keyed by
  # intended_use_id, which is `RPRC_19` expressed in a route.
  RC_RESPONSE=$(api_post "/intended_use/certificate" \
    "$(jq -n --arg hp "$HASH_PID" --argjson id "$IU_ID" '{hash_pid: $hp, intended_use_id: $id}')")
  if [ -n "${EDTP_DRY_RUN:-}" ]; then
    echo "  DRY RUN: no registration certificate written."
  else
    printf '%s' "$RC_RESPONSE" > "$RC_OUT"
    chmod 600 "$RC_OUT"
    echo "Intended-use registration certificate written to $RC_OUT."
    echo "  Its shape is unverified — the service documents it as JAdES and COSE, so check"
    echo "  whether it is a JWT, a JSON envelope or a detached signature before importing."
  fi
fi

cat <<EOF

Next, and in this order:

  1. The chain check, which is what actually closes blocker B1:

       ./scripts/verify-access-certificate-chain.sh $P12_OUT

     Importing before this passes is what docs/certificate-intake-runbook.md Step 0 forbids:
     a certificate that does not chain to a notified WRPACProviders anchor cannot work with a
     wallet, and trying produces a failure that looks like a platform bug.

  2. Record the matched anchor and the list-freshness line in
     docs/reference-wallet-testing.md §8.1.

  3. Only then, the imports in docs/certificate-intake-runbook.md Steps 1 and 2.

The state file is $STATE. It holds identifiers only. Re-running this script skips every step
already recorded there, so an interrupted session resumes rather than duplicating entities.
EOF
