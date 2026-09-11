# Certificate intake runbook — prepared, not run

**Nothing here has been run, and nothing can be until real certificates exist.** This is the sequence
for the moment they arrive: the gating chain check first, then import for each of the two roles.

It assumes the dual-role registration session in
[`registration-session-plan.md`](registration-session-plan.md) has happened and produced, for **each**
role, a PKCS#12 containing a certificate and its private key, plus a registration certificate.

> **Secrets.** The PKCS#12 passphrases, `hash_pid` and the platform tenant API key are secrets. Every
> script here takes them from an environment variable or a prompt, never from `argv` — `argv` is
> readable through `ps` and lands in shell history. They go in a gitignored local file or `.env`, never
> in a document, a log, a fixture or a commit.

---

## Step 0 — the chain check, which gates everything

**Do not import anything, and do not touch a wallet, before this passes.** `AS-WP-06-005` (`RPA_04`)
makes the Wallet accept only Access CA anchors from the notified LoTEs, so an unchecked certificate
produces a failure that looks like a platform bug.

```bash
export EDTP_P12_PASSIN='…'          # the PKCS#12 passphrase, not an argument
./scripts/verify-access-certificate-chain.sh path/to/rp-access.p12
```

It fetches the four dev LoTEs live, reports their freshness (warning past `NextUpdate`, noting within
48 hours), and says whether the leaf chains to an anchor on `WRPACProviders`.

| Outcome | What it means | Next |
|---|---|---|
| **Chains to a `WRPACProviders` anchor** | **Path A holds.** An *official*, unmodified wallet can be used for VaaS testing — the most valuable evidence available | Record in `reference-wallet-testing.md` §8.1, then Step 1 |
| Does not chain | Path A has failed | Record it, then Path B / **WD-3**. Do not import and hope |

`PubEAAProviders` had `NextUpdate` **2026-09-12**, so expect a rollover warning and re-check against
the current list rather than a remembered result.

## Step 1 — the Relying Party role

Two calls, in this order, and the order matters: the instance must hold its access certificate before a
policy version referencing an intended use can be published.

### 1a. Provision the instance with the access certificate

```bash
export PLATFORM_TENANT_API_KEY='…'
export TENANT_ID='…'
./scripts/import-access-certificate.sh <service-id> <engine-tenant-ref> path/to/rp-access.p12
```

The script exists because the engine's import endpoint takes an **EC private key as a JWK plus a
leaf-first PEM chain**, not a PKCS#12 — its web wizard converts for you, the API does not
(`interop-findings.md` A8). The key lives in a mode-600 file under a temporary directory removed on
exit, and in the request body. The platform stores only the opaque key-binding reference the engine
returns.

Afterwards, replace the development certificate everywhere it is referenced and **delete it** — a
self-signed certificate left configured alongside a real one is the kind of thing that quietly gets
used.

### 1b. Record the registration certificate, per intended use

```
POST /v1/tenants/{tenantId}/rp-services/{serviceId}/registration-certificates
{ "intendedUseId": "…", "jwt": "<the real registration certificate JWT>",
  "provider": "EUDIW reference RP Registration Service", "trustEnvironment": "TEST" }
```

**One certificate per intended use, not one per Service** — `RPRC_19` requires the certificate
applicable to *the current Service and intended use*, and the domain enforces the match
(`registrationCertificate.intendedUseId !== intendedUse.id` is refused, as is an expired `notAfter`).

Then republish the policy version that uses it, so the plan carries the real JWT instead of the TEST
placeholder, and **remove the placeholder**: `scripts/make-test-registration-certificate.mjs` output
must not survive next to a real certificate.

> `RPRC_19` stays unsatisfied even with a real certificate, because the engine will not emit it as
> `verifier_info` without a configured live registrar (gap **G2**). A real certificate removes *our*
> half of the problem; the engine's half remains. Say so in any report.

## Step 2 — the non-qualified EAA Provider role

```
POST /v1/tenants/{tenantId}/attestation-providers/{providerId}/provision
{ "engineTenantRef": "…",
  "signingCertificate": { "privateKeyJwk": {…}, "certificateChain": ["<leaf>", "…"] },
  "registrationCertificateJwt": "<the EAA Provider's registration certificate>" }
```

The response states `registrationCertificatePublished`, and
`GET …/attestation-providers/{providerId}/provider-authentication` then reports the conjunction a
Wallet actually faces — `registrationCertificatePresent`, `metadataSigned`,
`walletCanAuthenticateProvider`.

Two engine details that cost a debugging cycle each and are pinned by contract tests: the key's
`usageType` is **`attestation`** (not `signing`), and `registrationCertificate` needs **both**
`enabled: true` and `mode: "import"` — without `enabled` the certificate is stored and silently never
published.

### What this role cannot carry — engine gap G8

**There is no way to publish the Attestation Provider's access certificate.** ARF §6.6.2.2 expects the
Credential Issuer metadata to carry the provider's **access certificate and** its registration
certificate. The engine's `IssuanceConfig` has `signingKeyId` and `registrationCertificate` and no
access-certificate field at all, and `issuer_info` is assembled in exactly one place
(`oid4vci.service.ts`, `appendIssuerRegistrationCertificateInfo`) which only ever pushes
`format: "registration_cert"`.

So an EAA Provider access certificate obtained in the registration session **has nowhere to go** at this
engine version. Recorded as **G8**. It compounds G1: gate (a) is missing both the signature over the
metadata and one of the two certificates the metadata should carry.

Still obtain it in the registration session. It is needed for PID-during-issuance — where the issuer
acts as a relying party and authenticates the nested presentation request with an **access**
certificate, a path that does work — and it will be needed the moment the engine gains the field.

## Step 3 — after both roles are imported

1. Re-run the engine-facing contract suite. `tests/adapter/registration-certificate.test.ts` is written
   to **skip with a logged reason** when no registrar is configured, so it turns green by itself if G2
   is ever fixed — and the issuance contract test asserts `metadataSigned === false` with a message
   saying what to do when it starts failing. Neither is a test to "fix"; both are tripwires.
2. Re-run the chain check. It is cheap, and certificates get swapped.
3. Then, and only then, the VaaS run sheet:
   [`vaas-official-wallet-run-sheet.md`](vaas-official-wallet-run-sheet.md).
4. Then the faithful conformance profile:
   [`conformance-faithful-profile.md`](conformance-faithful-profile.md), which needs the real
   certificate to clear one of its four failures.

## What to update once this has been run

| | |
|---|---|
| `reference-wallet-testing.md` §8.1 | The chain-check result — the gating record |
| `reference-wallet-testing.md` §8A | Replace "TEST placeholder" with the real certificate's provenance |
| `docs/security-limitations.md` | Remove the self-signed development certificate entry, if it is gone |
| `docs/eudiplo-integration.md` §10B | G2's status, if the registrar changes anything |
| `docs/phase-0-findings.md` §8 | Q1a, resolved either way |

**Blocker B1 is closed only by a chain check that passes**, not by importing a certificate. Until then
nothing changes about what may be claimed.
