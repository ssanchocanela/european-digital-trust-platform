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

## The registrations are bound to a wallet and a PID — keep both

The RP Registration Service has no accounts. It authenticates by **OID4VP PID presentation**:
`/authentication` → QR → `/getpidoid4vp` → `hash_pid`, and `hash_pid` is the credential every subsequent
call carries. That is what made Q1 answerable without signing up for anything — and it has a consequence
that needs stating before anything is registered rather than discovered afterwards.

**The operator must retain the official wallet installation and the test PID inside it for the whole life
of these TEST registrations.** Everything the registrations make possible — amending registered
information, adding or changing an intended use, registering a further Service, renewing or re-enrolling
a certificate, and in all likelihood revoking one — requires logging in again, which requires presenting
that PID from that wallet.

| Action | Effect |
|---|---|
| Wiping the wallet, uninstalling it, or resetting the phone | **Loses the login.** The registrations may still exist and their certificates still work, but they become unmanageable |
| Letting the test PID expire without re-obtaining it | Same |
| Using a *different* wallet or a *different* synthetic test identity | Produces a different `hash_pid`, which is a different registrant |

So, concretely:

- **This is the one wallet installation that must not be wiped.** Note which device and which
  installation it is, in the run record, on the day it is used.
- Do the registration session on the **official** wallet, not the EDTP test build. The test build is
  rebuilt, reinstalled and uninstalled routinely — `INSTALL-AND-PID.md` even tells the operator to
  `adb uninstall` it to switch between release and debug — and none of that should be able to cost us the
  registrations.
- Keep the two wallets on **separate devices** if at all possible. They install side by side by design,
  but the failure mode here is a careless "reset this phone", and separate devices remove it.
- Re-obtain the PID *before* it expires, not after.

> **Unverified, so do not rely on it:** whether `hash_pid` is stable across a **re-issued** PID for the
> same synthetic identity. It is plausibly a hash over PID attributes, in which case re-issuance would
> reproduce it — but that is an inference, not something we have tested, and if the reference issuer
> assigns a fresh synthetic identity per issuance it is false. Treat the wallet-plus-PID as
> irreplaceable until someone has actually tested re-login after re-issuance, and record the result when
> they do.

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

**This check gates gate (a) as well, not only verification.** The pinned wallet validates the `x5c` chain
on signed issuer metadata with `VerificationContext.WalletRelyingPartyAccessCertificate`
(`EtsiCertificateChainTrust`) — the same trust context, and therefore the same `WRPACProviders` anchors,
as a verifier's access certificate. And per `ISS-MDATA-4.2.1-02` the metadata's signing certificate *is*
the provider's access certificate. So one chain check decides whether either gate could ever be
satisfied, and a single access certificate may serve both roles.
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

Still obtain it in the registration session, for three reasons. PID-during-issuance needs one — there
the issuer acts as a relying party and authenticates the nested presentation request with an **access**
certificate, a path that does work. It is what the engine will need the moment it gains the ability to
sign its metadata, because per `ISS-MDATA-4.2.1-02` the access certificate **is** the signing
certificate. And the chain check in Step 0 already tells you whether it would be accepted, since the
wallet validates it against the same anchors.

**Check whether one certificate can serve both roles** while you are in the session. The wallet uses one
trust context for both, so the question is whether the Registrar issues a single access certificate
usable for both roles or insists on one per role. Either answer is fine; not knowing which is what makes
a second session necessary.

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
