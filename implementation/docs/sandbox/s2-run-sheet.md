# Sandbox S2 — the first real sign-up, run sheet

- **Status:** written 12 November 2026. **Not yet run.** Nothing below has happened with a wallet.
- **Proves:** a person signs up with a PID from a test wallet, a second person is invited and joins,
  and both sign in again — the S2 "done when" of [`plan.md`](plan.md).
- **Does not prove** anything about certificates or trust lists issued by the sandbox. Those are
  S3, and this run does not use them.

## Why this run uses the existing test wallet and the development Access CA

The sandbox's own Access CA (ADR 0014) issues no certificate until S3, and no sandbox wallet build
exists yet. So the sign-in verifier — the sandbox operator's Relying Party Instance — uses an access
certificate from the **existing development Access CA** (`~/.edtp/dev-access-ca`), which the EDTP test
wallets **W8/W9** trust through WD-3.

The PID it asks for is one the test wallet already holds:
- from the reference issuer, through the seven reference anchors the EDTP TEST PID list carries
  (WD-4);
- or from "PID (demo)".

That matches ADR 0015 Decision 2: the sign-in anchors are the reference PID Providers and "PID (demo)".

Every result is from a **modified wallet** and is reported as such (CLAUDE.md §6.22). Record:
- the build (W8 or W9);
- its deviations;
- the position of *Check Registration Certificates*. It changes nothing here, because the sign-in
  verifier sends no registration certificate.

## Before the run

1. **Secrets** go into `.env`, never into a commit:
   - `PSEUDONYM_MASTER_KEY` (`openssl rand -base64 32`);
   - `SANDBOX_PORTAL_SECRET` (`openssl rand -hex 32`, different from every other secret).
2. **The operator's tenant and sign-in policy**, through the platform API with the admin key, as
   `tests/support/seed.ts` does in code:
   1. `POST /v1/tenants`: "EDTP Sandbox operator". Keep the tenant key.
   2. An organisation, a Relying Party (`TEST`), a service, and an intended use registering
      `given_name`, `family_name`, `birthdate`, `issuing_authority` and `issuing_country` for
      `dc+sd-jwt`, `urn:eudi:pid:1`.
   3. An engine tenant for it (`scripts/create-engine-tenant.sh sbx-operator`), then the instance
      with a development Access CA certificate (`scripts/import-access-certificate.sh`).
      **Run `scripts/verify-access-certificate-chain.sh` against the certificate first** (CLAUDE.md §8).
   4. The EDTP TEST PID list loaded into that engine tenant (`scripts/load-issuer-trust-list.mjs`),
      and mapped in `ENGINE_ISSUER_TRUST_LISTS`.
   5. A policy with one published version:
      - the five claims;
      - `resultPolicy` `DERIVED_CLAIMS` with one `PseudonymousSubject` derivation over them,
        `outputClaim` `"subject"`;
      - `trustPolicy.anchorSources` naming only the EDTP TEST PID list.
3. **The sandbox settings** in `.env`:
   - `SANDBOX_OPERATOR_TENANT_ID`;
   - `SANDBOX_SIGN_IN_POLICY_ID`;
   - `SANDBOX_PORTAL_PUBLIC_URL=http://localhost:3300`;
   - `SANDBOX_PARTICIPANT_TRUST_SOURCES`, set to the URL the sandbox PID list *will* have. It must
     differ from the EDTP TEST PID list, or sign-in refuses to start — which is the check working.
4. Restart the platform. Start the portal, with `SANDBOX_PLATFORM_URL` and `SANDBOX_PORTAL_SECRET`
   set:
   ```bash
   node --env-file=.env apps/sandbox-portal/dist/main.js
   ```
5. **Exposure.** The wallet must reach the engine's wallet-facing paths. Open the test-session tunnel
   through the gateway as for any phone test ([`../test-session-gateway.md`](../test-session-gateway.md)),
   and run its negative checks first. The portal stays on `localhost`: this run is **cross-device**.
   - The laptop's browser shows the QR code.
   - The phone presents.
   - That is the flow `EW-PIO-01-016` (`OIA_08c`) discourages, used here with the ADR 0009
     mitigations and described as such.

## The run

| # | Step | Expected | Seen |
|---|---|---|---|
| 1 | Open `http://localhost:3300`, choose *On my phone*, *Sign up with your PID* | A QR code, the page refreshing | |
| 2 | Scan with W8/W9; the wallet shows the operator's name; present the PID | The laptop page moves to *Create your account* | |
| 3 | Type a name and a fictitious organisation (country `ES`) | The dashboard; the organisation reads `SB:ES-000001` and **not verified** | |
| 4 | Create an invitation link (member) | A link, shown once | |
| 5 | In a private window, open the link; present a **different** PID (second wallet, or a re-issued PID with other values) | *Join the organisation*, then the dashboard as member | |
| 6 | As the member, open the organisation | No API key section, no remove buttons | |
| 7 | Sign out; sign in again with the first PID | The same account, owner | |
| 8 | Present a PID whose values differ from the first in case and spacing only, if one can be issued | The same account | |

**Afterwards, check the database** for the absence of PID values:
- `sandbox_people` holds only `subject` (43 characters) and the typed name;
- `presentation_results` for the sign-in holds only `{"subject": …}`.

## Recording the result

Record it in `docs/sandbox/runs.md`, created by this run:
- date and UTC times;
- wallet build, deviations, preference position;
- each step's outcome;
- anything that did not match.

Say "EDTP test wallet W9, a modified wallet", never "the Reference Wallet".
