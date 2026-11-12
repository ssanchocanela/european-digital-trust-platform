#!/usr/bin/env bash
# The sandbox VM's own backup (ADR 0017): both databases and the sealed CA key store, every night and
# before every deployment, into /var/backups/edtp-sandbox, keeping the last 14. Hetzner's daily server
# backups (7 kept) carry this directory off the VM.
#
#   infra/sandbox-vm/nightly-backup.sh [label]
#
# What it holds, and what it does not:
# - platform.dump: the platform database (participants, certificates, publications, audit). No
#   presentation or issuance content: the platform keeps none (ADR 0004).
# - engine.dump: the engine database, which holds the engine tenants' keys and status lists. Its
#   session rows are kept anonymised by the engine's cleanup (SESSION_CLEANUP_MODE=anonymize).
# - pki.tar: the PKI directory, keys SEALED under SANDBOX_KEYSTORE_KEY. The key is NOT in the backup;
#   the operator keeps a copy outside the VM. Without it the sealed keys open nothing.
# - never .env.
set -euo pipefail
ROOT="${HOME}/edtp/implementation"
DEST=/var/backups/edtp-sandbox
KEEP=14
label="${1:-nightly}"
[[ "$label" =~ ^[a-z0-9-]{1,40}$ ]] || { echo "backup: bad label" >&2; exit 64; }
ALERTS="${HOME}/.edtp/alerts.env"
[ -f "$ALERTS" ] && . "$ALERTS"

if [ -z "${EDTP_BACKUP_HOLDS_LOCK:-}" ]; then
  exec 9>/tmp/edtp-deploy.lock
  flock -w 600 9 || { logger -t edtp-sandbox-backup "skipped: a deployment holds the lock"; exit 75; }
fi

cd "$ROOT"
# Read the names it needs; .env is not sourced, so nothing in it runs as shell.
env_value() { sed -n "s/^$1=//p" .env | tail -1; }
PLATFORM_DB_USER="$(env_value PLATFORM_DB_USER)" PLATFORM_DB_NAME="$(env_value PLATFORM_DB_NAME)"
ENGINE_DB_USER="$(env_value ENGINE_DB_USER)" ENGINE_DB_NAME="$(env_value ENGINE_DB_NAME)"
C=(docker compose -f infra/sandbox-vm/docker-compose.sandbox.yml --env-file .env)
dir="$DEST/$(date -u +%Y%m%dT%H%M%SZ)-$label"
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$DEST" "$dir"
fail() {
  logger -t edtp-sandbox-backup -p user.err "FAILED: $1"
  [ -n "${ALERT_WEBHOOK_URL:-}" ] && curl -s -m 10 -o /dev/null -H "Title: EDTP sandbox" \
    -H "Priority: high" -d "EDTP sandbox: backup failed ($1)." "$ALERT_WEBHOOK_URL" || true
  exit 1
}
"${C[@]}" exec -T platform-db pg_dump -Fc -U "${PLATFORM_DB_USER:-edtp}" "${PLATFORM_DB_NAME:-edtp_platform}" \
  >"$dir/platform.dump" || fail "platform database"
"${C[@]}" exec -T engine-db pg_dump -Fc -U "${ENGINE_DB_USER:-eudiplo}" "${ENGINE_DB_NAME:-eudiplo}" \
  >"$dir/engine.dump" || fail "engine database"
sudo tar -C /var/lib/edtp-sandbox -cf "$dir/pki.tar" pki || fail "key store"
sudo chown "$(id -u):$(id -g)" "$dir/pki.tar"
( cd "$dir" && sha256sum platform.dump engine.dump pki.tar >SHA256SUMS )
chmod 600 "$dir"/*

# Keep the newest $KEEP.
ls -1d "$DEST"/*/ 2>/dev/null | sort | head -n -"$KEEP" | xargs -r rm -rf
logger -t edtp-sandbox-backup "backup $(basename "$dir") written"
echo "$dir"
