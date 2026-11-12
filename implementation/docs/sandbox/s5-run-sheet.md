# Sandbox S5 — the PID Provider role with a wallet, run sheet

- **Status:** written 12 November 2026. **Not yet run.** Nothing below has happened with a wallet.
- **Proves:** a participant's hosted PID issuer issues a synthetic PID into the sandbox wallet, and that
  PID is presented to another participant's hosted verifier — the closed loop of [`plan.md`](plan.md)
  S5. It also records what the wallet does with each PID defect.
- **Does not prove** anything about the issuance-side registration checks (`RPRC_22a`, `RPRC_22b`,
  `RPRC_23`). The sandbox wallet build carries WD-2, which switches them off whatever *Check
  Registration Certificates* says (G-10, [ADR 0016](../adr/0016-sandbox-signed-issuer-metadata.md),
  pending).

Everything here is a **modified wallet** result (CLAUDE.md §6.22). The PIDs are **synthetic**, signed
under a TEST CA, and are not PIDs of any Member State.

## 1. Setup, beyond S4's

1. **Wallet Provider anchors** in `~/.edtp/sandbox-pki/wallet-provider-anchors/*.pem`, extracted from
   the notified development WalletProviders list, as `scripts/setup-wallet-provider-trust.sh` reads it.
   The sandbox wallet build's wallet attestation comes from the Reference Implementation's development
   Wallet Provider.
2. **`ENGINE_WALLET_PROVIDER_TRUST_LIST_ID`** set to an id of your choice. Each hosted issuer's engine
   tenant gets that list loaded under that id. Unset, the issuer asks for no wallet attestation — a
   result to record as such.
3. Restart the platform. The test gateway's engine rules already allow the issuance paths (§1a).

## 2. The runs

Use two organisations: one PID Provider, and one Relying Party with its hosted verifier configured
`AC-00` + `RC-00` (S4).

| # | Issuer configuration | Then | What the requirement asks |
|---|---|---|---|
| 1 | `PID-00` + `RC-00` | Issue a synthetic PID to the sandbox wallet (same device, then QR) | Issued and stored |
| 2 | — | Present that PID to the Relying Party's hosted verifier | `VERIFIED`: the sandbox PID list anchors the sandbox PID CA |
| 3 | — | Revoke it (PID-03), then present it again | The verifier refuses on status (`VCR_04` and its status check) |
| 4 | `PID-01` + `RC-00` | Issue | The wallet refuses: signature not verifiable against the PID list (`ISSU_07`) |
| 5 | `PID-02` + `RC-00` | Issue | As 4, for an expired signing certificate |
| 6 | `PID-00` + `RC-05` | Issue, preference **on** then **off** | Under WD-2: no difference expected. Record it, because that is the G-10 statement measured |

Record each run in [`runs.md`](runs.md):
- the issuance id and the platform's status and failure code;
- what the wallet showed;
- for presentations, the S4 run report.

## 3. What may go differently, and is still a result

- **The engine may refuse to sign with an expired certificate** (row 5) before any wallet sees it. The
  issuance page then shows the failure code. Record it in `docs/interop-findings.md`.
- **The wallet may store a PID it should have refused**, if its issuance-time signature check differs
  from the presentation-time one. Then the verifier's outcome in row 2's position is the finding.
- **The PID's `issuing_authority` is the service's trade name with "(sandbox TEST)".** A verifier
  showing it is expected, not a leak.
