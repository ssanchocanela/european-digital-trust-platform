# What can be demonstrated, and what must be said while demonstrating it

Written 16 September 2026. **For anyone who has to show this platform to someone else.**

Everything here is a claim the repository can evidence, with a pointer to where. Nothing here is a
claim about conformance, readiness or an official wallet build — and §5 lists, in words, the
sentences that would be untrue if said. Those matter more than the running order.

---

## 1. The shape of the honest story

Three sentences, in this order, and the third is not a caveat bolted on at the end — it is the
finding.

1. **Verification works against a real wallet.** A wallet completed a presentation against this
   platform: policy to DCQL, signed request object over public HTTPS, encrypted response,
   verification, result policy, derived claim.
2. **Issuance works, end to end, to a conformant client.** Credential offer, issuer metadata,
   authorization server metadata, DPoP-bound access token, key-binding proof, and a signed
   attestation returned — then recorded, revocable, and revoked.
3. **No wallet can collect that attestation, and the reason is not in this platform.** The wallet
   must authenticate the Credential Issuer from **signed** issuer metadata before it will request
   anything (ARF §6.6.2.2). The wrapped engine publishes none. That is blocker **B7**, it is an
   engine gap, and no certificate, configuration or amount of platform work closes it.

The third sentence is the most valuable thing this project has to say to an audience that is
deciding whether to build on the ecosystem. It is measured, not assumed, and it was watched
happening on a phone.

---

## 2. What to show, in order

### 2a. The console, as an operator sees it

**Issuance → Define a credential to issue.** One form: what the attestation is, its attributes, who
may receive one and where the values come from, how it is collected, the Rulebook that governs it.
It offers only the eligibility rules and authentic sources this deployment has actually registered —
read from the API, not hard-coded.

**Point at the fixture warning deliberately.** The screen says outright that the only authentic
source is a fixture, so anything defined there issues test data. Showing a system that says what is
not real about itself is a stronger demonstration than showing one that does not.

**Then the trust gate at the top of every issuance screen.** It says *"A wallet cannot authenticate
this issuer, so nothing here can be collected"*, with the two reasons and their blockers named. This
is the platform refusing to look ready. Say why that is deliberate: an operator who publishes an
offer and learns from a user that nothing works has been failed by the software.

### 2b. A verification, live

**This is the strongest thing to demonstrate**, because it is real end to end and a real wallet
completed it. Recorded with its evidence in
[`reference-wallet-testing.md`](reference-wallet-testing.md) §8.1b: **`VERIFIED`**, result
`{"over_18": false}`, over public HTTPS, with the wallet's own log showing it validated the
certificate chain.

Say, in the same breath, that the wallet is a **modified build** and what the modification is —
§5 below has the exact wording.

The minimisation is worth pausing on because it is a design claim the run evidences: `birthdate`
went into the adapter, `over_18` came out, and no `birthdate` appears anywhere in the result. That
is `AS-RP-01-002` (`OIA_16`) being satisfied at the result boundary rather than only in storage.

### 2c. An issuance, as protocol evidence

Walk the chain with the conformant client and show the platform's own record move to **`ISSUED`**
with an attestation in the register. Then revoke it from the console and watch the register change.

**Name what the client is.** It is roughly 120 lines of Node that speak OpenID4VCI correctly. It
authenticates nothing about the issuer — which is precisely the thing a Wallet Unit is required to
do and this ecosystem cannot yet support. So the run evidences that the platform and the wrapped
engine complete a real issuance, and evidences **nothing** about any wallet.

### 2d. The blocker, on the phone, if there is time

§8.1c is the most persuasive single artefact in the repository: a wallet refusing on screen with
*"This issuance request has been blocked because the provider could not be verified by your
Wallet."* The platform did everything right and the ecosystem stopped it. That is the finding.

---

## 3. The questions that will be asked, and the answers that are true

**"So is it ready?"** No, and it says so itself. V0 operates in the `TEST` trust environment only;
`PRODUCTION` is gated on a legal question that has not been resolved
([`knowledge-alignment.md`](knowledge-alignment.md) KA-3, Q2). Every shortcut is listed in
[`security-limitations.md`](security-limitations.md).

**"Would it work with the official wallet?"** Verification: **not today**, and not for a reason this
platform can fix. A Wallet Unit accepts only access certificates chaining to anchors on lists
notified by Member States (`AS-WP-06-005` / `RPA_04`), and the route to obtaining one is itself
broken — the reference Registrar accepts the request, returns a null identifier and persists nothing
([`interop-findings.md`](interop-findings.md) **C10**). That is blocker **B1**. Issuance:
**no**, blocker **B7**, and that one is not about certificates at all.

**"How much of this is your code versus the engine?"** The platform owns the product model and
wraps the engine behind ports. The findings register in
[`interop-findings.md`](interop-findings.md) carries **26 recorded divergences** between the engine,
the reference tooling and the specifications; **eight** of them are written up as upstream defect
reports in [`upstream/`](upstream/), drafted and **not filed** — filing is a decision nobody has
taken yet, and saying they are filed would be untrue. Two of the eight — the status-list decode
(**A25**) and the revocation endpoint (**A26**) — were found by running the thing rather than by
reading about it.

**"Can you revoke?"** Yes, and it was broken until today: the engine returned 500 to every status
change, because its own contract marks a field optional and the omitted path is the one that
crashes. The platform now always sends it. **A26**.

**"What happens if it half-works?"** The register distinguishes a status the platform *intends* from
one the engine has *acknowledged*, and shows "not in effect" for the difference. That exists because
during the A26 outage the register read `REVOKED` for an attestation whose status list had never
been touched.

---

## 4. What is genuinely unfinished, said plainly

- **No wallet has ever collected an attestation from this platform.** Not once. B7.
- **The only authentic source is a fixture.** A real one is a connector somebody writes; it is not a
  setting.
- **The §7.3 PID-during-issuance flow is unexercised against a wallet**, because the wallet stops
  before reaching it.
- **mdoc verification with status checking on does not work**, and the reason is in the engine
  (**A25**). The one successful mdoc presentation had status checking **disabled**, which
  `AS-AP-07-023` (`VCR_13`) permits only after a documented risk analysis this project has not done.
- **No registration certificate exists** (blocker **B3**), so the registration layer of trust is
  untested in both directions.

---

## 5. Sentences that would be untrue

Say none of these, in a room, a slide or a follow-up email.

| Do not say | Say instead |
|---|---|
| "Tested with the EUDI Reference Wallet" | "Tested with a wallet we built from the Reference Implementation, with the modifications named in our deviation register" |
| "ARF compliant" / "conformant" | "Built against ARF 3.0.0 and the Technical Specifications, with divergences recorded" |
| "Production ready" / "pilot ready" | "V0, `TEST` trust environment only" |
| "We can issue credentials to wallets" | "We issue attestations end to end; no wallet can collect one yet, and the blocker is in the ecosystem" |
| "Revocation is ARF compliant" | "Revocation is irreversible in the platform, as `AS-AP-07-007` requires" |
| "Age verification from the PID" | "Age derived from the PID date of birth — the PID carries no age attribute" |
| "Registered with the Registrar" | "Recorded what a registration would authorise, in a `TEST` environment. It is not a registration" |

The first row is not pedantry. The whole reason the modified wallet exists is that an unmodified one
**refuses** this platform's certificates, and a result obtained from a build that was changed to stop
refusing says nothing about the build that refuses. `CLAUDE.md` §8 makes this rule absolute, and the
deviation register at [`../tools/test-wallet/deviations.md`](../tools/test-wallet/deviations.md)
exists so the modification can be stated precisely rather than glossed.

---

## 6. Before any demonstration

1. **Check the trust gate reads what you expect.** `/issuance` states it at the top of the screen.
2. **Check the certificates are in date.** The gate panel shows each one's expiry; a signing
   certificate that has expired lets every step of an issuance succeed until the last one.
   [`rotate-attestation-key.sh`](../scripts/rotate-attestation-key.sh) replaces it.
3. **Retire the policies you are not showing.** A tenant full of debugging debris is the first thing
   an audience sees.
4. **If a phone is involved, open the tunnel first** (`./scripts/test-session.sh up`) and close it
   after (`down`). It is synthetic data only, hand-started, and never left running.
