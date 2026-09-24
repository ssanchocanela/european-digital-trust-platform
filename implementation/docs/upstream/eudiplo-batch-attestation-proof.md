# Draft upstream issue — EUDIPLO: batch issuance with an `attestation` proof

**Status: draft, not filed.** For `openwallet-foundation/eudiplo`. Recorded in
[`interop-findings.md`](../interop-findings.md) A34.

---

**Title:** Batch issuance is impossible with the `attestation` proof type: a key attestation must carry exactly one attested key

**Version:** v7.6.0 (`ghcr.io/openwallet-foundation/eudiplo:7.6.0`,
`sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667`)

### What happens

With `batchSize > 1` in the issuance configuration, the Credential Issuer metadata advertises
`batch_credential_issuance.batch_size`, so a wallet may request a batch. For the `attestation`
proof type, `Oid4vciService.issueCredentialsForProofs` then:

- requires exactly one element in `proofs.attestation` (`resolveParsedCredentialProofs`:
  *"Attestation proof type requires exactly one key attestation JWT"*), and
- requires that key attestation to carry exactly one entry in `attested_keys`
  (*"Attestation proof must contain exactly one attested key"*),

and issues one credential per proof. So an `attestation`-proof request can yield only one credential,
and a batch cannot be served.

### Why it matters

OpenID4VCI 1.0 defines the `attestation` proof type as a key attestation whose
`attested_keys` may list several keys, and batch issuance with this proof type means one credential
per attested key. The EUDI Wallet Core (`eudi-lib-android-wallet-core` 0.30.2, with
`eudi-lib-jvm-openid4vci-kt` 0.13.1) requests a batch in exactly that way: one key attestation with N
attested keys. It has no plain JWT proof. A JWT proof from it always carries a key attestation, and
the engine resolves that signer as `custom` and rejects it.

The EUDI ARF 3.0.0 makes once-only batches Method A (`ISSU_43`–`ISSU_47`), which every Wallet
Solution must support (`ISSU_37`). With this wallet, an EUDIPLO issuer cannot serve Method A, and a PID
the wallet requests as once-only arrives as a single credential that its first presentation spends.

### Expected

For an `attestation` proof, issue one credential per entry in `attested_keys`, up to the configured
`batchSize`, with each credential bound to its own key. Refuse only when the count exceeds
`batchSize`.

### Workaround in use

We publish `credential_reuse_policy` with `limited_time` (ARF Method B). The engine supports that, and
the wallet then stores a single reusable credential. This works, but it gives up the unlinkability that
Method A exists to provide.
