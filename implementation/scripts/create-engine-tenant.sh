#!/usr/bin/env bash
# Creates an engine tenant and adds its credentials to ENGINE_TENANT_CREDENTIALS in .env.
#
#   ./scripts/create-engine-tenant.sh <engine-tenant-ref> "<display name>"
#   ./scripts/create-engine-tenant.sh pid-1 "EDTP test PID Provider"
#
# One engine tenant per Relying Party Instance (ADR 0002 Decision 3) and per Attestation Provider
# (`interop-findings.md` A20, enforced by a unique index) — so a second provider needs a second
# tenant, and this is the procedure `.env.example` describes by hand, made repeatable.
#
# **Every role, at creation.** Roles cannot be widened afterwards — `PATCH /api/tenant/{id}` rejects
# a `roles` key — and a tenant cannot grant its client a role it lacks (A16). A tenant created too
# narrowly has to be recreated.
#
# The client secret is written into .env and **never printed**: it authenticates every management
# call on the tenant. Restart the platform API afterwards so it reads the new entry.
set -euo pipefail

REF="${1:-}"
NAME="${2:-$REF}"
ENV_FILE="${ENV_FILE:-.env}"
ENGINE="${ENGINE_LOCAL_URL:-http://localhost:3000}"

[ -n "$REF" ] || { echo "usage: $0 <engine-tenant-ref> [display name]" >&2; exit 1; }
[[ "$REF" =~ ^[a-z0-9-]+$ ]] || { echo "the ref must be lowercase letters, digits and dashes." >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE not found; run from implementation/." >&2; exit 1; }
for tool in curl jq; do command -v "$tool" >/dev/null || { echo "$tool is required." >&2; exit 1; }; done

current="$(grep '^ENGINE_TENANT_CREDENTIALS=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
case ",$current," in
  *",$REF="*) echo "$REF is already in ENGINE_TENANT_CREDENTIALS. Nothing to do." >&2; exit 1 ;;
esac

# Read the two values we need, without sourcing the whole file into this shell.
root_id="$(grep '^ENGINE_CLIENT_ID=' "$ENV_FILE" | cut -d= -f2-)"
root_secret="$(grep '^ENGINE_CLIENT_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$root_id" ] && [ -n "$root_secret" ] || { echo "ENGINE_CLIENT_ID/SECRET missing from $ENV_FILE." >&2; exit 1; }

token="$(jq -n --arg id "$root_id" --arg s "$root_secret" \
    '{grant_type:"client_credentials", client_id:$id, client_secret:$s}' |
  curl -sS -X POST "$ENGINE/api/oauth2/token" -H 'content-type: application/json' --data-binary @- |
  jq -r '.access_token // empty')"
[ -n "$token" ] || { echo "could not obtain the engine's root token." >&2; exit 1; }

response="$(jq -n --arg id "$REF" --arg name "$NAME" '{
    id: $id, name: $name,
    roles: ["presentation:manage","presentation:request","issuance:manage","issuance:offer",
            "clients:manage","registrar:manage","tenant:admin"]
  }' |
  curl -sS -X POST "$ENGINE/api/tenant" -H "authorization: Bearer $token" \
    -H 'content-type: application/json' --data-binary @-)"

client_id="$(echo "$response" | jq -r '.client.clientId // empty')"
client_secret="$(echo "$response" | jq -r '.client.clientSecret // empty')"
if [ -z "$client_id" ] || [ -z "$client_secret" ]; then
  echo "the engine did not return a client. Its answer, secrets removed:" >&2
  echo "$response" | jq 'del(.client.clientSecret)' >&2 || true
  exit 1
fi

entry="$REF=$client_id:$client_secret"
updated="${current:+$current,}$entry"
# Rewritten through a temporary file so a failure cannot leave .env half-written.
tmp="$(mktemp "$ENV_FILE.XXXXXX")"
awk -v line="ENGINE_TENANT_CREDENTIALS=$updated" \
  'BEGIN{done=0} /^ENGINE_TENANT_CREDENTIALS=/ && !done {print line; done=1; next} {print}' \
  "$ENV_FILE" > "$tmp"
chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"

echo "Engine tenant '$REF' created with every role; client '$client_id' added to"
echo "ENGINE_TENANT_CREDENTIALS in $ENV_FILE (secret not shown)."
echo "Restart the platform API so it reads it:  docker compose up -d --force-recreate platform-api"
