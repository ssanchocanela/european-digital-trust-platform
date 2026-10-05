#!/usr/bin/env bash
# Sets up "Nóminas Demo", the fictitious payroll provider that issues the income certificate Banco
# Horizonte's loan asks for: its organisation, its Attestation Provider (TEST) and its
# attestation-signing certificate, on its own engine tenant.
#
#   ./scripts/create-engine-tenant.sh nominas-1 "Nominas Demo"   # once; restart platform-api
#   PLATFORM_TENANT_API_KEY=… ./scripts/setup-income-issuer.sh
#
# It is setup-large-family-issuer.sh with another issuer's names: the same steps, the same
# idempotence, the same trust list to republish afterwards. Then:
#
#   EDTP_ATTESTATION_DEFINITION=scripts/income/income-certificate.json \
#     node scripts/register-large-family.mjs issuance <attestationProviderId> <identifyPolicyId>
#
# The provider, its employer data and its certificate exist nowhere. `TEST` environment only.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export ENGINE_TENANT_REF="${ENGINE_TENANT_REF:-nominas-1}"
export EDTP_LARGE_FAMILY_ISSUER_STATE="${EDTP_INCOME_ISSUER_STATE:-$HOME/.edtp/income-issuer.json}"
export ISSUER_LEGAL_NAME="Nominas Demo S.L. - TEST ONLY, fictitious"
export ISSUER_PUBLIC_BODY=false
export ISSUER_EUID="ESTEST.EDTPNOM1"
export ISSUER_PROVIDER_IDENTIFIER="ESTEST.EDTP-NOM-PROVIDER-1"
export ISSUER_CERT_SUBJECT="/CN=Nominas Demo - income certificates - TEST ONLY/O=EDTP development/C=ES"
export ISSUER_DISPLAY_NAME="Nóminas Demo"
export ISSUER_NEXT="EDTP_ATTESTATION_DEFINITION=scripts/income/income-certificate.json node scripts/register-large-family.mjs issuance"
exec "$HERE/setup-large-family-issuer.sh"
