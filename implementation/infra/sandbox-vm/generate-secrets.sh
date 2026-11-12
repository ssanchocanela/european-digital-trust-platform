#!/usr/bin/env bash
# Prints fresh secrets for the sandbox VM's .env (ADR 0017), to be appended on the VM itself:
#
#   infra/sandbox-vm/generate-secrets.sh >> .env && chmod 600 .env
#
# Refuses to run if .env already holds any of them: regenerating SANDBOX_KEYSTORE_KEY would leave the
# sealed CA keys unreadable, and regenerating the database passwords would lock the platform out.
set -euo pipefail
ENV_FILE="${1:-.env}"
NAMES=(PLATFORM_DB_PASSWORD ENGINE_DB_PASSWORD ENGINE_MASTER_SECRET ENGINE_CLIENT_SECRET
  ENGINE_CREDENTIALS_KEY PLATFORM_ADMIN_API_KEY PSEUDONYM_MASTER_KEY SANDBOX_PORTAL_SECRET
  SANDBOX_KEYSTORE_KEY)
if [ -f "$ENV_FILE" ]; then
  for n in "${NAMES[@]}"; do
    if grep -q "^$n=." "$ENV_FILE"; then
      echo "generate-secrets: $ENV_FILE already sets $n; refusing to generate a second one." >&2
      exit 1
    fi
  done
fi
hex() { openssl rand -hex "$1"; }
b64() { openssl rand -base64 "$1"; }
cat <<OUT
PLATFORM_DB_PASSWORD=$(hex 24)
ENGINE_DB_PASSWORD=$(hex 24)
ENGINE_MASTER_SECRET=$(hex 32)
ENGINE_CLIENT_SECRET=$(hex 32)
ENGINE_CREDENTIALS_KEY=$(b64 32)
PLATFORM_ADMIN_API_KEY=$(hex 32)
PSEUDONYM_MASTER_KEY=$(b64 32)
SANDBOX_PORTAL_SECRET=$(hex 32)
SANDBOX_KEYSTORE_KEY=$(b64 32)
OUT
