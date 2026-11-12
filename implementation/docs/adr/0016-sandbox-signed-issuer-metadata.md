# ADR 0016 — Signed issuer metadata for the sandbox's hosted PID issuer

- **Status:** ACCEPTED, 12 November 2026: the user chose **option 2**, signing the metadata in front of
  the engine for sandbox issuers only. **Implemented in S5b, not yet run with a wallet.**
- **Date:** 12 November 2026
- **Context documents:**
  - [`docs/issuer-trust-model.md`](../issuer-trust-model.md) — gate (a), G1 and G8;
  - [`docs/upstream/eudiplo-signed-metadata.md`](../upstream/eudiplo-signed-metadata.md) — drafted, not filed;
  - [`tools/test-wallet/deviations.md`](../../tools/test-wallet/deviations.md) WD-2;
  - [`docs/sandbox/specification.md`](../sandbox/specification.md) J8 and G-10.
- **Numbered 0016**, after the sandbox's 0014 and 0015.

## Context

**A PID Provider participant would most want to test what the hosted issuer cannot exercise.**

- **The engine signs no issuer metadata.** EUDIPLO 7.6.0 produces no `signed_metadata`, and publishes
  the registration certificate in the unsigned document (G1, G8).
- **The pinned wallet requires signed metadata.** ETSI TS 119 472-3 V1.1.1 routes provider
  authentication through one JWS:
  - signed with the **access** certificate, carried in `x5c` (`ISS-MDATA-4.2.1-01/-02`,
    `ISS-MDATA-ACC_CERT-4.2.2-01/-02`);
  - with `issuer_info` at the top level of the signed payload (`ISS-MDATA-REG_CERT-4.2.3-02`).
- **So every sandbox wallet build carries WD-2.** And WD-2 does more than accept unsigned metadata: it
  switches off the wallet's issuer registration-certificate checks whatever *Check Registration
  Certificates* says, because `IssuerCreator` applies them only under `RequireSigned` (CLAUDE.md §6.21).
- **The consequence, stated on every page today:** the issuance-side defects
  - `AS-AP-44-005` (`RPRC_22a`),
  - `AS-AP-44-006` (`RPRC_22b`),
  - `AS-AP-44-007` (`RPRC_23`, the sandbox's RC-12),
  - and the entitlement check (RC-11)

  are offered as take-away certificates only. Nothing on the hosted issuer tests them.

## Options

| # | Option | What it buys | What it costs |
|---|---|---|---|
| 1 | **Wait for upstream.** File the drafted issue; the engine signs its metadata with an `access` key chain | The fix in the right place, for the platform as well as the sandbox | Unknown time. The draft is not filed: filing is the user's decision |
| 2 | **Sign in front of the engine, for sandbox issuers only.** A platform route serves `/.well-known/openid-credential-issuer/issuers/{ref}` for sandbox engine tenants. It fetches the engine's document, moves `issuer_info` to the top level, adds `signed_metadata` signed with the issuer's **access** certificate, and the test gateway routes that one path to the platform | WD-2 can leave the sandbox build. RC-11, RC-12 and the issuance-side `RPRC_22a/b` and `RPRC_23` become testable on the hosted issuer | Owning a slice of the OpenID4VCI surface the engine exists to own. The issuer's access key must stay in the sandbox's sealed key store to sign — a key the platform otherwise never keeps. The document must stay consistent with the engine's (cache, refresh on reconfiguration). New negative probes |
| 3 | **Keep WD-2** and keep saying so (today's state) | Nothing new | The issuance side stays untested, permanently |

## Proposal

**Option 2, as its own milestone after S6, together with option 1:** file the upstream issue now, and
retire option 2 when an engine release signs its metadata.

Why option 2 holds up:
- **It is confined to sandbox issuers.** The platform's own issuers are untouched, and the gateway
  routes only sandbox engine tenants' metadata path.
- **Its key custody matches the sandbox's CA keys** (SB1): the issuer's access key goes into the same
  sealed key store, as a sandbox key.
- **It is the only route** by which a participant can learn what an unmodified-in-this-respect wallet
  does with their provider registration certificate.

Two consequences to state now, so they are not discovered later:
- **The sandbox build would need a second profile without WD-2**, because the W-builds and the
  platform's own demonstrations still need WD-2 against unsigned engines.
- **The wallet then validates the access certificate's chain with the WRPAC trust context**
  (`issuer-trust-model.md`). So the hosted issuer's access certificate must come from the sandbox
  Access CA, which the sandbox build already trusts.

## Decision

**Option 2, decided by the user on 12 November 2026.**
- A platform route serves the Credential Issuer metadata of **sandbox** engine tenants, signed with the
  issuer's access certificate (from the sandbox Access CA), with `issuer_info` at the top level of the
  signed payload.
- The test gateway routes that one path for sandbox tenants to the platform.
- A sandbox wallet profile without WD-2 follows, so the issuance-side defects (RC-11, RC-12, and the
  `RPRC_22a/b` / `RPRC_23` checks) become testable on the hosted issuer.

**Option 1, filing the drafted upstream issue, was not part of the answer.** Filing stays the user's
decision, and option 2 is to be retired if an engine release ever signs its metadata.

## Implementation (S5b, 12 November 2026)

**The format is the pinned wallet's, read from its compiled OpenID4VCI library 0.13.1**
(`DefaultCredentialIssuerMetadataResolver`, `OpenId4VCISpec`):
- the wallet asks for the well-known document with `Accept: application/jwt`;
- it processes a JWT with `typ` `openidvci-issuer-metadata+jwt`, requiring `sub` (exact: the
  Credential Issuer identifier) and `iat`;
- it takes the chain from `x5c`.

The sandbox's JWT carries the engine's metadata unchanged as its claims, plus `sub`, `iss` and `iat`.

| Piece | Where |
|---|---|
| The issuer's access certificate, any WRPAC variant, `dNSName` = the engine host; key in the sealed store, a fresh one per configuration | `SandboxIssuerService.configure`, migration 0017 |
| The engine's metadata, read through the issuer port | `fetchCredentialIssuerMetadata` (adapter) |
| Signing, and the route | `SandboxMetadataService`; `GET /sandbox/public/issuer-metadata/{ref}` |
| Routing | the test gateway, `GATEWAY_SANDBOX_SIGNED_METADATA=on`: `GET /.well-known/openid-credential-issuer/issuers/sbx-iss-*` only |
| The wallet | `build.sh --profile sandbox-strict`: the sandbox profile without WD-2 |

**What changes for the catalogue:**
- RC-11 and RC-12 are offered on the hosted issuer (the flag is now `issuanceSide`, not
  `takeAwayOnly`);
- the WRPAC variants can be put on an issuer, testing `ISSU_34` at issuance;
- **with the strict build** the issuer registration checks (`RPRC_22a/b`, `RPRC_23`) run.

**What does not change:**
- the ordinary sandbox build keeps WD-2;
- every result says which build it came from;
- the strict build cannot take a PID from "PID (demo)", whose engine tenant is not a sandbox issuer
  and whose metadata stays unsigned. The sign-in PID comes from the reference issuer instead.

**Not yet verified:** that the pinned wallet accepts the signed metadata in practice. The format
was read from the library's bytecode, and the signature, `typ`, `sub` and chain are tested here. The
first wallet run is in [`s5b-run-sheet.md`](../sandbox/s5b-run-sheet.md).
