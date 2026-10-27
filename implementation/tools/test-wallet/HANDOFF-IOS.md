# Handoff — replicating the EDTP test wallet changes on iOS

The Android EDTP test wallet (build **F16**) is a **modified build** of the EUDI Reference
Implementation. This page lists the changes that make it behave as it does now, so an iOS developer can
apply the equivalents on the EUDI **iOS** reference wallet. It is written from the Android deviation
register; the authoritative per-change detail (anchor text, exact mechanism, standards analysis) is in
[`deviations.md`](deviations.md), and each Android change is a patch in `deviations/wd-NN.patch`.

**Same honesty rules apply to the iOS build.** It is a modified build, never "the Reference Wallet" in
any result; WD-17 and WD-20 are **relaxations** and any result that depends on them must say so.

## What does NOT carry to iOS (Android build identity only — skip)
`applicationId`/bundle id, the `edtptest`/`fnmtce`/`fnmtcediag` flavours, our signing key, the
on-screen red banner, `BuildConfig.EDTP_*`, and **WD-7** (release logging). iOS has its own identity,
signing and logging; give the iOS build its own distinct bundle id and a "modified build" marker, but
none of this is a behaviour change to port.

## Not wallet changes (context — do NOT implement in the wallet)
These were fixed in **FNMT-RCM's back-end**, not the wallet: the mDL signer (sign the mDL with the mDL
list cert, not the PID cert), the verifier's P-384 Request-Object signing, and the registration
certificate (`provides_attestations`, the status host). Also: the phone must be on a network/DNS that
resolves the FNMT dev hosts (`*.dev.credenciales.fnmt.es`, `cebsi-aks-dev…`) — an operational point,
not a wallet change.

---

## 1. Trust lists → the Commission's development lists  (config)

Point the wallet's provider lists at the Commission dev lists. Android sets these in
`core-logic/.../WalletCoreConfigImpl.kt` (the `edtptest` source set); on iOS they are the equivalent
Wallet Kit trust-list configuration.

| List | URL to configure | Android deviation |
|---|---|---|
| PID providers | `https://development.trust.tech.ec.europa.eu/lists/eudiw/pid-providers.json` | WD-4 |
| WRPAC providers | `https://development.trust.tech.ec.europa.eu/lists/eudiw/wrpac-providers.json` | WD-3 |
| WRPRC providers | `https://development.trust.tech.ec.europa.eu/lists/eudiw/wrprc-providers.json` | WD-8 |
| mDL providers (`eaaProviders["mdl"]`) | `https://development.trust.tech.ec.europa.eu/lists/eudiw/mdl-providers.json` | WD-12 |
| pub-EAA providers | **leave at the EUDI reference list** `https://trustedlist.serviceproviders.eudiw.dev/LOTE/json/PubEAAProviders.jwt` | — |

- **pub-EAA:** the Commission's `pub-eaa-providers.json` still returns **403 (not published)**, so there
  is no CE URL to point to yet. When the CE publishes it, repoint pub-EAA to the CE URL too.
- These lists **roll over**: honour `NextUpdate` / re-fetch; do not cache a stale copy.

## 2. mDL is trusted from the mDL list  (WD-12, extension)
Wallet Core trusts an attestation issuer only through a providers list, and its EU baseline has **no
mDL entry**, so an mDL cannot be trusted at all out of the box. WD-12 adds the mDL list to the baseline
(maps the mDL issuance/revocation service types) **and** classifies the ISO doctype
`org.iso.18013.5.1.mDL` under the `"mdl"` list. On iOS: add the mDL providers list to the trust
baseline and classify the mDL doctype against it (otherwise the iOS wallet-kit, like Android, treats
the mDL as a generic public-EAA and never trusts it). *(Android: `deviations/wd-12.patch` against the
ETSI 119602 library's consultation module.)*

## 3. ETSI TS 119 602 list parsing/validation  (defect fixes in the list library)
The Android wallet uses the KMP library `eudi-lib-kmp-etsi-1196x2`. iOS uses its own ETSI-list
parsing/validation (or, if it consumes the same KMP library, the same patches apply). Replicate:

- **WD-10 — `LoTELegalNotice` as a multilingual string.** The list's `PolicyOrLegalNotice.LoTELegalNotice`
  is sent as a multilingual character string; the library modelled it as a structured object and
  failed to parse the **whole** list → every list unusable. Accept `LoTELegalNotice` as a string.
  (TS 119 602 V1.1.1 §6.3.11; the lib's own bundled JSON schema says `string`.) *(`deviations/wd-10.patch`.)*
- **WD-13 — validate the chain up to the list anchor, not past it.** An ETSI list states which
  certificate is the trust **anchor**; PKIX takes the anchor as an input (RFC 5280 §6.1), so the
  validator must stop at the first certificate in the chain that **is** a list anchor and not require
  a path beyond it. Without this, a chain whose anchor is an intermediate (not the root) is refused
  (`Path does not chain with any of the trust anchors`). *(`deviations/wd-13.patch`.)*
- **WD-15 — a leaf that IS an anchor is trusted directly.** If the leaf is **byte-for-byte** a trust
  anchor of the list (within validity), trust it directly. Built on WD-13. *(`deviations/wd-15.patch`.)*

These three gate both the issuer-metadata chain (gate a) and attestation trust (gate b). On iOS,
replicate in the equivalent chain-validation and list-parsing code.

## 4. Registration certificate (RPRC)  (defect fixes in Wallet Core)
- **WD-14 — `srv_description` as an array of arrays.** Read the registration certificate's
  `srv_description` as ETSI **TS 119 475 V1.2.1** defines it (array of arrays), in addition to the flat
  form. iOS: the registration-certificate parser. *(`deviations/wd-14.patch`, Wallet Core.)*
- **WD-16 — status list may be a CWT.** When the registration certificate's status list cannot be had
  as a JWT, fetch it as a **CWT** and verify it the same way. iOS: the registration-cert status check.
  *(`deviations/wd-16.patch`, Wallet Core.)*
- **WD-17 — CWT status list sent as base64url text (relaxation).** FNMT-RCM's status endpoint returns
  the CWT **base64url-encoded as text**; decode it before reading. This is a **transport relaxation**
  (`draft-ietf-oauth-status-list §8.2` does not allow it); the token is still fully verified. iOS: same
  tolerance. *(`deviations/wd-17.patch`, Wallet Core.)*

Note: *Check Registration Certificates* is a wallet setting, **off by default**, that gates the whole
RPRC check (issuer and verifier). iOS must expose/honour the same switch; test both positions.

## 5. HTTP client Accept headers  (defect fixes)
The app hands Wallet Core its own HTTP client with a JSON content-negotiation plugin that **adds**
`Accept` types to requests that must carry one type alone. Replicate on the iOS HTTP client:

- **WD-11 — signed issuer metadata.** A request to `/.well-known/openid-credential-issuer` asking for
  signed metadata must send `Accept: application/jwt` **alone** (not `application/jwt, application/json`).
  (ARF §6.6.2.2.) *(`deviations/wd-11.patch`.)*
- **WD-19 — OpenID4VP Request Object.** A request for the Request Object (`request_uri`) must send
  `Accept: application/oauth-authz-req+jwt` **alone** (OpenID4VP 1.0 §5.10). *(`deviations/wd-19.patch`.)*

## 6. Protocol/offer behaviour  (config)
- **WD-6 — credential response encryption `REQUIRED` → `SUPPORTED`** (security relaxation). Accept an
  issuer that offers no response encryption. iOS: the OpenID4VCI issuance config
  (`credentialResponseEncryption` policy). *(`deviations/wd-6.patch`.)*
- **WD-18 — accept the Launchpad URL schemes** `eu-eaap://` (presentation) and `eu-eaa-offer://`
  (credential offer). iOS: register the schemes (Info.plist) and accept them in the deep-link/offer
  parser. *(`deviations/wd-18.patch`.)*
- **WD-20 — PID reused across presentations** (`RotatingBatch`, one credential) instead of used once
  (`OnceOnly`, ten) — **privacy relaxation** (presentations become linkable). Only if the iOS build
  needs the PID to survive repeated presentations for the demo. iOS: the PID issuance batch / reuse
  policy. *(`deviations/wd-20.patch`.)*
- **WD-5 — issuer list** (which issuers the *From list* screen offers) — cosmetic/config; set the iOS
  build's own issuer list as needed.

---

## Minimum set to make FNMT-RCM issuance/presentation work on iOS
Trust lists on CE (§1), **WD-12** (mDL), **WD-10/WD-13/WD-15** (list parse + chain), **WD-14/WD-16/WD-17**
(RPRC), **WD-11/WD-19** (Accept headers), **WD-6** (encryption). WD-18 if using the Launchpad QR schemes;
WD-20 only if repeated PID presentations are needed. WD-5/WD-7 are cosmetic/Android-only.

The exact Android patches are in `tools/test-wallet/deviations/`; each `deviations.md` section has the
anchor text and the standards citation to map onto the iOS codebase.
