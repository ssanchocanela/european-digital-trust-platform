# ADR 0014 — The sandbox's trust domain: its own CAs, registrar and lists

- **Status:** PROPOSED, 12 November 2026. The S0 decisions D1, D2 and D6 were accepted by the user; the
  ADR as a whole awaits the S1 checkpoint.
- **Date:** 12 November 2026
- **Context documents:** [`docs/sandbox/s0-findings.md`](../sandbox/s0-findings.md) §2, §6.2–§6.4;
  [`docs/sandbox/specification.md`](../sandbox/specification.md) §5, §7.
- **Numbered 0014.** 0013 is held by PR #25.

## Context

An organisation in the sandbox needs access certificates, registration certificates and, as a PID
Provider, a PID signing certificate, all of which a test wallet must trust. No such certificate can be
obtained from the reference ecosystem:
- the reference RP Registration Service persists no intended use, so it issues neither certificate
  (`docs/interop-findings.md` C10);
- the official wallet accepts only notified anchors (`AS-WP-06-005` `RPA_04`, `EW-DM-44-005`
  `RPRC_02a`, `AS-AP-10-007` `ISSU_07`).

The platform already runs a development Access CA, a development PID CA and EDTP TEST lists. Those
serve the running demonstrations, carry the seven reference anchors forward, and are built by hand.

## Decision

1. **The sandbox is a separate trust domain, with its own anchors and its own lists (D1).**
   - Its lists are three ETSI TS 119 602 LoTEs (Annexes D, F, G): PID Providers, Access CAs and
     WRPRC providers. They are published by the sandbox at its own URLs and re-signed on every change
     and at least daily.
   - The existing EDTP TEST lists and the development CAs are **not** reused and **not** changed.
   - A wallet build reads one domain or the other; the sandbox build is `--profile sandbox`.

2. **The CAs and signers of the domain:**

   | Name (CN, each ending `- TEST ONLY`) | Signs | On a list? |
   |---|---|---|
   | EDTP Sandbox Access CA | WRPACs, correct and defective (except AC-01) | **yes**, Access CA list |
   | EDTP Sandbox Untrusted Access CA | WRPACs of defect AC-01 only | **never** |
   | EDTP Sandbox Registrar | WRPRCs, correct and defective (except RC-04); the WRPRC status lists; the register read API's JWS | **yes**, WRPRC-provider list |
   | EDTP Sandbox Untrusted Registrar | WRPRCs of defect RC-04 only | **never** |
   | EDTP Sandbox PID CA | Participants' PID signing certificates (D2, sandbox-issued) | **yes**, PID list |
   | EDTP Sandbox Untrusted PID CA | PID signing certificates of defect PID-01 only | **never** |
   | EDTP Sandbox LoTE Signer | The three lists | Pinned in the wallet build |

   Each CA is one self-signed root, P-256, with `pathLenConstraint` 0, valid two years, issuing
   leaves directly. An intermediate tier is not worth its weight in a test domain.

   The Registrar signs WRPRCs with a **leaf** under its root, because a WRPRC carries an `x5c` chain
   (`EW-DM-44-004`, `RPRC_02`). The root is the listed anchor.

3. **Defective certificates are issued under the trusted anchors**, except the "unknown issuer"
   defects. A wallet stops at the first failing check, so a defect under an untrusted anchor would
   test only the anchor (S0 §6.2).

4. **Revocation:**
   - **WRPACs** — a CRL per Access CA, published by the sandbox (`AS-MS-27-019`, `Reg_12`). No OCSP
     in v1.
   - **WRPRCs** — an IETF Token Status List per registrar, referenced from each WRPRC's `status`
     claim, as TS 119 475 V1.2.1 CSS-6.2.3.10 asks (no CRL/OCSP for WRPRCs) and as Wallet Core 0.30.2
     reads it.
   - **PIDs** — the engine's own status list, as for every issuer the platform runs.

   **Suspending a participant revokes every certificate it holds** at once (TS 119 411-8
   REV-6.3.9-02..04).

5. **The PID list carries the sign-in anchor set as well as the sandbox PID CA.** The sign-in set is
   the reference PID Providers' anchors and "PID (demo)". A wallet must hold a PID it signs up with;
   the sign-in verifier trusts **only** that set (ADR 0015 Decision 2).
   - Brought-in participant anchors (v1.1) are added after the operator's approval, the sandbox's
     stand-in for `AS-MS-27-026` (`Reg_19`).
   - **Not** the untrusted PID CA.

6. **The signed issuer metadata gap is accepted for v1, and said (D6).**
   - The engine publishes no `signed_metadata` (G-10), so the sandbox wallet build includes WD-2.
   - The issuance-side registration checks (`RPRC_22a`, `RPRC_22b`, `RPRC_23`) are offered as
     take-away certificates only, never as tested on the hosted issuer.
   - Signing the metadata in a component in front of the engine is assessed in S5, in its own ADR.

7. **`TEST` is written into everything the domain signs:**
   - `- TEST ONLY` in every CA name;
   - `TEST ` before every organisation name in a certificate;
   - a sandbox policy OID in every WRPAC;
   - a scheme operator name "EDTP Sandbox — TEST ONLY" on every list.

   The domain's anchors are never placed in a `PRODUCTION` configuration, and the platform refuses to
   start the sandbox in one.

## Consequences

- The platform becomes an issuer of X.509 certificates, CRLs, JWS registration certificates, status
  lists and trust lists. That is a new package (`sandbox-pki`) and a new cryptographic dependency,
  which the user approves in S2 (specification Q-S6).
- **CA keys live on a VM without an HSM.** Listed in `docs/security-limitations.md`. A leaked key
  compromises only the sandbox domain, which only sandbox wallet builds trust.
- The sandbox wallet build is one more test wallet, under CLAUDE.md §6.22 and its delivery rules.
- Lists change with every participant, so `LoTESequenceNumber` and the published history matter:
  every publication is kept (`AS-WP-31-014`, `TLPub_08`).
- **The lists use EU `LoTEType` values.** The wallet selects lists by them. The reuse is stated in each
  list's scheme information and on the portal; the publisher, signer and URLs are the sandbox's own.

## Alternatives considered

- **Extend the existing EDTP TEST lists.** Rejected at D1: they serve the demonstrations, which a list
  changing with every participant would disturb.
- **One CA for everything.** Rejected: the WRPAC, WRPRC and PID trust domains are separate in the ARF
  (four domains collapsed into one is a known shortcut of the dev environment, CLAUDE.md §6.19), and a
  sandbox that collapses them cannot show a wallet that keeps them apart.
- **Defective certificates under an untrusted CA.** Rejected: §6.2 of S0.
