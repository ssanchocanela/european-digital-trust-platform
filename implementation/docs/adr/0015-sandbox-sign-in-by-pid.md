# ADR 0015 — People in the sandbox: sign-up and sign-in by PID

- **Status:** ACCEPTED, 12 November 2026. Its points D3, D4 and D5 were accepted by the user at the S0
  checkpoint; the ADR as a whole was approved with the S1 specification on 12 November 2026.
- **Date:** 12 November 2026
- **Context documents:** [`docs/sandbox/s0-findings.md`](../sandbox/s0-findings.md) §5 G-1/G-2, §6.1,
  §6.5, §6.6; [`docs/sandbox/specification.md`](../sandbox/specification.md).
- **Numbered 0015.** 0013 is held by PR #25; 0014 is the sandbox trust domain.

## Context

Until now the platform has had **no people**:
- one API key per tenant;
- an operator console behind a single shared credential.

The sandbox is self-service: an organisation's staff sign up, come back, and work in a portal. The
user asked for sign-up to "verify the PID".

Three facts from S0 constrain how:

1. **A participant acting as PID Provider gets its signing anchor onto the sandbox's PID list.** If
   sign-in trusted that list, any participant could mint a PID in any name and sign in as anyone
   (§6.1).
2. **A PID identifies a natural person, not an organisation, nor anyone's authority to act for one**
   (§6.6). `AS-MS-27-036` (`Reg_25`) asks a registrar to identify a Relying Party at a level
   proportionate to risk; in a `TEST` domain with synthetic data that level is low, and saying so is
   the honest course.
3. **A sign-in presentation is the platform acting as Relying Party Instance for itself**, so
   `AS-RP-01-002` (`OIA_16`) binds it: unique elements are discarded and not communicated.

## Decision

1. **Sign-up and sign-in are a PID presentation to the platform's own sign-in verifier.** It is a
   Relying Party Instance of the sandbox operator, with an access certificate from the sandbox Access
   CA (ADR 0014), under one presentation policy. `SAME_DEVICE` by default; `QR` allowed for this
   policy under ADR 0012, because sign-in is most often done from a desktop browser. The ADR 0009
   mitigations apply and `OIA_08d` is still not claimed.

2. **The sign-in verifier trusts a fixed, operator-controlled set of PID Provider anchors** — the
   reference PID Providers' anchors and the EDTP "PID (demo)" issuer. It **never** trusts the list
   that participants' PID Providers are added to. The two sets are configured separately, and a
   start-up check refuses a configuration in which they share an anchor that came from a participant.

3. **What is requested is the minimum to tell people apart:** `given_name`, `family_name`,
   `birthdate`, `issuing_authority` and `issuing_country` (all mandatory in the PID Rulebook). They
   are read by a `PseudonymousSubject` derivation (Decision 4) and **only its output is kept, even as
   a result**. No PID value reaches the platform's database.

4. **What is kept of the person:**
   - a **pseudonymous subject**: HMAC-SHA-256 over those five normalised values, under a key derived
     for the sandbox's tenant from `PSEUDONYM_MASTER_KEY` (the `PseudonymousSubject` derivation, in
     the domain's result policy);
   - a **display name the person types** at sign-up. It is not prefilled from the PID: a prefilled
     name would make a PID value travel to the page and back.

   The raw PID values exist only in the call stack that applies the result policy, as for every
   presentation (ADR 0004). Never a PID value in a log or an audit record.

   *Amended in S2, 12 November 2026:* the S1 text keyed the subject on "the issuing PID Provider
   anchor". The platform's presentation result does not carry the anchor, so `issuing_authority` and
   `issuing_country`, which the PID Provider signs, stand in for it. The display name was to be
   "confirmed" from the PID; it is typed, for the reason above.

   The basis is the attributes, not the wallet installation. Re-installing a wallet or re-issuing
   the PID keeps the person's account (the opposite of the reference registry's `hash_pid`,
   `docs/interop-findings.md` C11). **The price is plain:**
   - two people with the same name and birth date, holding PIDs from the same provider, are one
     account;
   - a person whose PID comes from a different provider is a different account.

   Both are acceptable in a `TEST` sandbox with synthetic PIDs, and both are written in the portal's
   help text.

5. **Sessions.** After a successful presentation the portal sets a `__Host-` cookie:
   - `Secure`, `HttpOnly`, `SameSite=Lax`;
   - an opaque session id; sessions live in the database;
   - 30 minutes idle, 8 hours absolute.

   Signing out deletes the session. There is no password and no second factor: the PID presentation
   *is* the authentication, at the level the sandbox needs.

6. **Organisations are self-declared, and marked unverified.** The person who signs up declares an
   organisation: legal name, country, and an identifier.
   - Where the organisation has an EUID, it may be entered.
   - Otherwise the sandbox assigns `TEST-SBX-<n>`.
   - The sandbox does **not** check that the EUID exists or that the person may act for the
     organisation.
   - Every register entry and every certificate for the organisation carries the sandbox's `TEST`
     marker, and the portal shows "organisation not verified".
   - Verifying representation is future work, and is exactly what a later attestation role in this
     sandbox could provide.

7. **Roles:** `owner` and `member`, per organisation.
   - The person who signs up is its owner.
   - An owner invites others by a single-use link, valid 72 hours; the invitee signs in by PID to
     accept.
   - An owner can remove a member, and cannot remove the last owner.
   - **A sandbox operator role exists outside every organisation**, held by configuration, not by
     sign-up, for the duties of the specification §8 (approve a brought-in anchor, suspend a
     participant).

8. **Machines use API keys, as the platform already does.** An owner can create API keys for the
   organisation:
   - shown once, stored hashed, revocable;
   - scoped to the organisation exactly as a platform tenant key is scoped to its tenant (CLAUDE.md §9:
     tenant derived from the credential, never from a path).

   **One sandbox organisation is one platform `Tenant`.**

## Consequences

- The platform gains its first people: tables for users, memberships, sessions and invitations, and
  an audit record for every sign-in, membership change and key creation. None holds a PID value.
- The sign-in verifier needs a PID in the wallet from one of the fixed providers. A participant's
  wallet must therefore hold a reference or "PID (demo)" PID before it can sign up. The portal says so
  on its first screen, and links the "PID (demo)" issuer.
- A person can be locked out by a PID whose attributes change (a corrected name). An owner of the
  same organisation can re-invite them; otherwise the operator can merge accounts. The merge is an
  audited operator action, not self-service.
- `Reg_25` is not claimed. The identification level is stated as "a PID presentation, organisation
  self-declared".

## Alternatives considered

- **Reuse the connector's OpenID Provider (edt-pid-connector ADR-009/013) and sign in through it.**
  A good design, in another language and another product. Porting it means a protocol surface (OIDC)
  the portal does not need, since the portal is the only client.
- **Use `hash_pid`-style wallet binding.** Rejected for the lock-out it causes on re-installation.
- **Trust every PID the test wallet trusts.** Rejected: §6.1.
- **Email and password, with PID as a second step.** Rejected: the user asked for PID, and passwords
  bring a credential store this sandbox does not otherwise need.
