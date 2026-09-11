# Sheet 2 — first VaaS end-to-end test, with the OFFICIAL wallet

**Prepared, not run.** It cannot be run until the Q1a chain check passes and a real access certificate
is imported — [`certificate-intake-runbook.md`](certificate-intake-runbook.md).

This is the single most valuable test available, because the wallet is **unmodified**. Every result from
the EDTP test wallet carries "modified build" for the rest of its life; a result from an official build
does not. So this runs first, with nothing modified, and the test wallet is used only where an official
build cannot go.

**Same-device first, then QR.** `SAME_DEVICE` is the tested default. `QR` is a cross-device redirect
flow, which `EW-PIO-01-016` (`OIA_08c`) says Wallet Units SHOULD NOT support and `OIA_08d` obliges a
Relying Party using one to mitigate; two of the five ARF §4.4.3.2 challenges cannot be addressed by a
Relying Party at all, so **`OIA_08d` is never claimed as satisfied** and QR is never presented as the
demonstrated flow.

**Synthetic data only.**

---

## 0. Preconditions — all of them, in order

| # | | Evidence |
|---|---|---|
| 1 | Q1a chain check **passed** | Recorded in `reference-wallet-testing.md` §8.1 |
| 2 | Real access certificate imported, development certificate deleted | `import-access-certificate.sh` output |
| 3 | Real registration certificate recorded for the intended use, TEST placeholder removed | The policy version in use |
| 4 | Tunnel up, allow-list **negative checks all 404** | [`test-session-gateway.md`](test-session-gateway.md) §4 |
| 5 | `ENGINE_PUBLIC_URL` and `PLATFORM_PUBLIC_URL` set to the public origins **before** `docker compose up` | `docker compose config` |
| 6 | Official wallet installed from its official distribution, at the pinned release | Settings → about |
| 7 | The wallet holds a **test PID** | Its document list |
| 8 | The phone is on a **non-intercepted network**, and the certificate issuer it sees is the real one | Checked in the phone's browser — see below |

If 1 fails, stop: this sheet is not available, and the matrix row moves to the test wallet with WD-3.

> Precondition 5 is the one that silently ruins a session. `ENGINE_PUBLIC_URL` is baked into every
> wallet-facing URL the engine emits, so setting it after a session exists produces a request the phone
> cannot fetch, and the symptom looks like a wallet problem.

## The phone must be on a non-intercepted network

**Use mobile data, or a network you know does not intercept TLS. Not corporate Wi-Fi.**

This is not a precaution, it is a hard requirement with two distinct failure modes — and the second is
worse than the first because it looks like success.

| Network | What happens | Why it matters |
|---|---|---|
| Clean (mobile data, home) | The wallet sees **our** certificate | Correct |
| Intercepting, proxy CA **not** trusted by the phone | TLS fails. The wallet refuses — it sets `cleartextTrafficPermitted="false"` and will not accept an untrusted chain either | A wasted session, but at least it is obvious |
| Intercepting, proxy CA **trusted** by the phone (a managed device) | **Everything appears to work**, and the wallet validated a certificate issued by the proxy, not ours | The run proves nothing about TLS, and a trust result obtained through a MITM is not a trust result |

### Symptoms of interception

In `adb logcat`, any of:

- `javax.net.ssl.SSLHandshakeException`, `SSLPeerUnverifiedException`
- `java.security.cert.CertPathValidatorException: Trust anchor for certification path not found`
- `Chain validation failed` from the Ktor/Android HTTP stack
- the issuer's authorisation page failing to load while other sites work

On the phone, before starting: open the engine's well-known URL in the phone's browser, view the
certificate, and **check the issuer**. If it does not say the CA that actually issued it — Let's Encrypt,
or the tunnel provider's CA — the connection is being intercepted. That one check takes ten seconds and
saves a whole session.

### Two rules that follow

1. **Never install a proxy CA on the test phone.** It would convert the obvious failure into the silent
   one, and every subsequent trust result from that device would be worthless.
2. **`EDTP_JAVA_TRUSTSTORE` is build-machine-only.** It exists so the Gradle wrapper can download
   through a corporate proxy on the *laptop*, where nothing about trust is being tested. It has no phone
   equivalent and must never acquire one: the phone's trust store is the thing under test.

## 1. Same-device

### 1a. Create the presentation

From the laptop, against the platform API:

```
POST /v1/presentations
{ "policyId": "…", "policyVersion": 1, "businessReference": "vaas-official-001",
  "interaction": { "mode": "SAME_DEVICE" } }
```

Record the returned interaction URI **verbatim**. It must be `https://` on the tunnel host — if it
still says `localhost`, precondition 5 was missed.

### 1b. Hand it to the wallet

Open the interaction URI **on the phone** — in its browser, or as a link. Same-device means the browser
and the wallet are the same device, so the URI must be opened there, not scanned.

### 1c. What to observe, in order

| # | Expected | If not |
|---|---|---|
| 1 | The wallet opens and shows a consent screen | Check the scheme handler registration; capture logcat |
| 2 | It shows **our** verifier identity from the access certificate | If it shows a warning about the verifier, the certificate is the suspect — re-run the chain check |
| 3 | It shows the **purpose** and a privacy-policy link, localised | `AS-WP-06-015` (`RPA_10`). Record exactly what it displayed |
| 4 | It lists **only** the claims the policy asked for | Minimisation, visible. Anything extra is a compiler defect and a finding |
| 5 | After approval, the browser returns to `…/v1/presentations/{id}/return` | That route is deliberately minimal — it echoes the id and a sentence, and no outcome |
| 6 | `GET /v1/presentations/{id}` → `VERIFIED` with only the result policy's output | Branch on `failureCode`, **never** on the engine's `status` |

### 1d. Registration-certificate check — **both positions, one run each**

The wallet's *Check Registration Certificates* setting is a **runtime preference, default off**, and it
gates **both** the issuer and the verifier registration check. So both positions are testable without
rebuilding, and both must be reported.

| Position | Expected |
|---|---|
| **Off** (default) | The flow completes. This exercises the access-certificate trust layer **only** — say so; a passing demo here is not a passing registration layer |
| **On** | Expect an `EW-DM-44-019` (`RPRC_17`) warning: the Wallet could not validate the registered information, because the engine does not emit the certificate as `verifier_info` (gap **G2**). **This is the expected result and it is evidence of G2**, not a failure of the run |

Record the **verbatim** wording of whatever the wallet shows with the check on. It is the best available
description of what a User would see.

## 2. QR (cross-device) — second, and with the caveats attached

```
POST /v1/presentations
{ …, "interaction": { "mode": "QR" } }
```

Display the QR on the laptop, scan it with the phone.

The four ADR 0009 mitigations are active and the residual risks ride in every cross-device audit record.
Confirm they are present in the audit record for this presentation, and **do not remove them**.

Report QR as *an additional flow that works*, never as the demonstrated flow, and never as `OIA_08d`
satisfied.

## 3. Stop conditions

Stop and record rather than working around, in every one of these cases:

- the wallet refuses our verifier — that is `RPA_04`/B1 territory and a configuration change would mask it;
- the wallet shows claims the policy did not request;
- the result contains an attribute value the result policy did not emit;
- anything appears in a platform log that looks like content — a VP token, an SD-JWT, a PID attribute.
  The redaction deny-list test fails the build for this, so a live occurrence is a serious finding.

## 4. The run record

```
Run:                        W1-VAAS-001        (…-002 for QR, …-003/-004 for check-on variants)
Date (UTC):
Operator:

--- wallet ---
Wallet:                     OFFICIAL build, unmodified
Distribution and version:
Build hash:                 n/a — official distribution, not built by us
Active deviations:          none — this is not our build
Holds test PID:             yes | no

--- platform and engine ---
EUDIPLO version:            7.6.0
EUDIPLO image digest:       sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667
Platform commit:
Migrations applied:
ENGINE_PUBLIC_URL:
PLATFORM_PUBLIC_URL:
Gateway negative checks all 404:              yes | no
Phone network:                                mobile data | other (which):
Certificate issuer seen by the phone:
Proxy CA installed on the device:             no   (must be "no")
G7 error stripping enabled:                   no   (must be "no" here)

--- trust material ---
Access certificate:         real (RP Registration Service) | development self-signed
Chain check (Q1a) result:   pass | fail — date:
Registration certificate:   real | TEST placeholder | none
Registration-certificate check preference:    off | on

--- flow ---
Interaction mode:           SAME_DEVICE | QR
Interaction URI scheme/host:
Consent screen shown:                         yes | no
Verifier identity displayed (verbatim):
Purpose displayed (verbatim):
Privacy policy link displayed:                yes | no
Claims listed (exactly):
Claims requested by the policy (exactly):
RPRC_17 warning shown (verbatim):
Outcome:                    VERIFIED | failureCode=…
Result returned to the client (exactly):

--- assertions ---
Claims listed == claims requested:            yes | no
No content in platform logs:                  yes | no
Audit record holds the cross-device residual risks (QR only):   yes | n/a
```

## 5. What a successful run does and does not establish

**Does:** that an unmodified official Reference Wallet completes a presentation against this platform
with a real access certificate — the strongest interoperability evidence available to V0, and the thing
blocker B1 has been in the way of.

**Does not:**

| | |
|---|---|
| ARF or TS conformance | Not claimed, in any form. A working flow is not a conformance statement |
| `RPRC_19` | Still unsatisfied — the engine's half (G2) is untouched by a successful run |
| `OIA_08d` | Never claimed, QR or not |
| Anything about issuance | Gate (a) and gate (b) are unaffected. **B7 still stands** |
| Production readiness | No |
