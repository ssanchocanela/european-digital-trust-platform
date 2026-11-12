# Sandbox S5b — signed issuer metadata with a wallet, run sheet

- **Status:** written 12 November 2026. **Not yet run.**
- **Proves:** the pinned wallet's OpenID4VCI stack accepts the sandbox's signed issuer metadata, and
  that with WD-2 removed the wallet runs its issuer registration checks on a sandbox issuer
  ([ADR 0016](../adr/0016-sandbox-signed-issuer-metadata.md)).
- **Does not prove** anything about an official wallet build. This is a modified wallet, without WD-2
  but with WD-3, WD-4, WD-6, WD-7 and WD-8 (CLAUDE.md §6.22).

## Setup, beyond S5's

1. **The test gateway**, with `GATEWAY_SANDBOX_SIGNED_METADATA=on`.
2. **Check from outside**:
   ```bash
   curl -H 'accept: application/jwt' https://<engine host>/.well-known/openid-credential-issuer/issuers/<sbx-iss-…>
   ```
   It must answer a JWT whose header `typ` is `openidvci-issuer-metadata+jwt`. Without the header it
   must answer the engine's JSON.
3. **The strict wallet**:
   ```bash
   ./build.sh --profile sandbox-strict --sandbox-base https://<platform host>/sandbox/public
   ```
   It installs beside the ordinary sandbox build. Its sign-in PID must come from the **reference**
   issuer: "PID (demo)" publishes unsigned metadata, which this build refuses.
4. **Reconfigure every hosted issuer** made before S5b, so it gets its metadata-signing access
   certificate.

## The runs

The hosted issuer starts at `PID-00` + `RC-00` + `AC-00`. For each row, change one thing and issue
with the strict build.

| # | Change | *Check Registration Certificates* | What the requirement asks |
|---|---|---|---|
| 1 | — | off | Issued: the metadata verifies against the sandbox Access CA |
| 2 | — | on | Issued: the registration certificate is valid |
| 3 | `AC-01` | off | The wallet refuses the issuer before asking for a PID (`AS-AP-10-061`, `ISSU_34`) |
| 4 | `AC-02` | off | As 3, for an expired access certificate |
| 5 | `RC-05` | **on** | The wallet does not request issuance (`AS-AP-44-005`, `RPRC_22a`) |
| 6 | `RC-06` | **on** | As 5, not bound to the access certificate (`AS-AP-44-006`, `RPRC_22b`) |
| 7 | `RC-12` | **on** | As 5, attestation type not registered (`AS-AP-44-007`, `RPRC_23`) |
| 8 | `RC-11` | **on** | No HLR — entitlement missing (ARF §6.6.2.3) |
| 9 | rows 5–8 | **off** | What the wallet does without the preference: record it |
| 10 | — | — | The same issuer with the **ordinary** sandbox build (WD-2): issued whatever the registration variant, which is the G-10 statement measured |

Record each run in [`runs.md`](runs.md):
- the build;
- the preference position;
- the platform's issuance status;
- what the wallet showed.

## What may go differently, and is still a result

- **The wallet may refuse the signed metadata itself**, for a reason the bytecode reading missed: a
  claim it requires, or a header. That is the first thing this run can find. Record the wallet's error
  as precisely as a debug build lets you.
- **The wallet may validate the `x5c` chain in a trust context other than the access-certificate one**
  `issuer-trust-model.md` read from the source. Then row 1 fails, and the record says which context.
