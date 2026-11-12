# Sandbox S4 — the Relying Party role with a wallet, run sheet

- **Status:** written 12 November 2026. **Not yet run.** Nothing below has happened with a wallet.
- **Proves:** the hosted verifier presents sandbox-issued certificates — correct and defective — to the
  EDTP sandbox wallet build, and each run is recorded with what the wallet did, *Check Registration
  Certificates* off and on. This is the S4 "done when" of [`plan.md`](plan.md).
- **Does not prove** anything about an official wallet build: it trusts none of the sandbox's anchors
  (specification §2).

Everything here is a **modified wallet** result: the EDTP sandbox wallet build, deviations
`wd-2,wd-3,wd-4,wd-6,wd-7,wd-8`. Say so in every record (CLAUDE.md §6.22).

## 1. One-time setup

1. **The trust domain**, outside the repository:
   ```bash
   SANDBOX_KEYSTORE_KEY=$(openssl rand -base64 32) node packages/sandbox-pki/dist/cli.js init
   ```
   Keep the key in `.env`.
2. **The sign-in anchors** in `~/.edtp/sandbox-pki/pid-sign-in-anchors/*.pem`:
   - the seven reference PID Provider anchors, extracted from the notified PID list;
   - the development PID CA (`~/.edtp/dev-pid-ca/ca.crt`) for "PID (demo)".

   The sandbox PID list carries them (ADR 0014 Decision 5), so the sandbox wallet accepts the PID you
   sign in with.
3. **Exposure.** A named tunnel with two hosts through the test gateway (`docs/test-session-gateway.md`):
   - the engine host;
   - the platform host, whose allow-list now includes `/sandbox/public/…` (§1b).

   **Run the negative checks first**: both `/sandbox/v1/…` probes must answer `404`.
4. **`.env`**, beyond S2's settings:
   - `SANDBOX_PKI_DIR`, `SANDBOX_KEYSTORE_KEY`;
   - `SANDBOX_PUBLIC_BASE_URL=https://<platform host>/sandbox/public`;
   - `SANDBOX_VERIFIER_DNS_NAME=<engine host>`;
   - `ENGINE_ROOT_CLIENT_ID`, `ENGINE_ROOT_CLIENT_SECRET`, `ENGINE_CREDENTIALS_KEY` (runtime engine
     tenants);
   - `SANDBOX_PARTICIPANT_TRUST_SOURCES=https://<platform host>/sandbox/public/lote/PIDProviders.jwt`.

     This is the sandbox PID list, which participants will be added to in S5. The sign-in policy must
     **not** name it.

   Restart the platform. It publishes the lists at start: check that
   `https://<platform host>/sandbox/public/lote/WRPACProviders.jwt` answers.
5. **The sign-in verifier needs a sandbox access certificate.** A sandbox wallet trusts only the
   sandbox's Access CA, so the operator's instance from S2 (development Access CA) cannot sign anyone
   in.
   1. Make a key and a request (`openssl ecparam … ; openssl req …`), then issue the certificate:
      ```bash
      node packages/sandbox-pki/dist/cli.js issue-access --csr req.pem --dns <engine host> \
        --public-base https://<platform host>/sandbox/public --legal-name "EDTP Sandbox operator" \
        --trade-name "EDTP Sandbox sign-in" --country EU --identifier SB:EU-000000 --service SIGNIN \
        --support https://<platform host> --out operator-wrpac.pem
      ```
   2. Make a PKCS#12 of the key and that chain, and import it with `scripts/import-access-certificate.sh`.
   3. **Chain-check it** against the sandbox Access CA before any wallet use (CLAUDE.md §8, in spirit:
      the sandbox's own anchor is the one that matters here).
6. **The wallet**:
   ```bash
   ./build.sh --profile sandbox --sandbox-base https://<platform host>/sandbox/public
   ```
   Install it beside your W-build: it has its own applicationId. Issue it a PID from "PID (demo)".
   Record the APK's SHA-256.

## 2. The runs

Sign up in the portal (S2's flow, now against the sandbox wallet). Register a Relying Party service, an
intended use with `given_name` and `family_name`, and configure the hosted verifier.

Then, for each row: reconfigure, start a run (`SAME_DEVICE` first), present, and fill in the
observation form.

| # | Access | Registration | *Check Registration Certificates* | What the requirement asks of the wallet |
|---|---|---|---|---|
| 1 | AC-00 | RC-00 | off | Presents (the baseline) |
| 2 | AC-00 | RC-00 | on | Presents, no warning |
| 3 | AC-01 | RC-00 | off | Stops: unknown access CA (`RPA_04`) |
| 4 | AC-02 | RC-00 | off | Fails access-certificate validity (`RPA_05`) |
| 5 | AC-03 | RC-00 | off | As 4 |
| 6 | AC-04 | RC-00 | off | Revoked — no HLR; ARF §6.6.3.2 |
| 7 | AC-05 | RC-00 | on | Binding cannot hold (RC-06 consequence) |
| 8 | AC-06 | RC-00 | off | `x509_san_dns` client id not in the SAN |
| 9–19 | AC-00 | RC-01 … RC-10, RC-13 | **on**, then off | As the run page states for each; off should change nothing for registration defects |

For each row, record the following in [`runs.md`](runs.md), created by the first run:
- the run id;
- the platform's outcome and failure code;
- the observation;
- and, when you have a debug build at hand, the Wallet Core reason the log shows.

## 3. What can go differently from the table, and is still a result

- **The engine may refuse to send a defective certificate** before the wallet sees it: an expired one,
  or one with no DNS name for its client identifier. The run report then shows the platform's failure
  code and no wallet behaviour. That is a finding about the engine, recorded in
  `docs/interop-findings.md`, not a defect of the run.
- **The wallet may stop at an earlier check** than the one a defect targets. The self-test says the
  certificate fails only its own check; a wallet that stops elsewhere is worth recording precisely.
- **The registration defects only show with the preference on.** With it off, a wallet that presents
  anyway is behaving as built, not as the requirement asks. Record both.
