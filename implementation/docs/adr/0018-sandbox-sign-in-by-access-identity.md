# ADR 0018 — Sandbox sign-in by the Access identity; the PID becomes optional

- **Status:** ACCEPTED, 14 November 2026, by the user, the day it was drafted, and built the same day
  (PR #50). The user decided the direction: signing in with a PID must not be mandatory. **Not deployed
  yet:** the sandbox VM still runs the ADR 0015 sign-in until the user confirms a deployment.
- **Date:** 14 November 2026
- **Amends:**
  - [ADR 0015](0015-sandbox-sign-in-by-pid.md): Decisions 1, 4, 5 and 7 change; Decisions 2 and 3 keep
    applying, but only to the optional PID presentation;
  - [ADR 0017](0017-sandbox-vm.md) §2: the bullet "Sign-in still needs a PID".
- **Context documents:** [`specification.md`](../sandbox/specification.md) §3, J1, J2;
  [`infra/sandbox-vm/`](../../infra/sandbox-vm/README.md).
- **Numbered 0018**, the next free number after the sandbox's 0014–0017.

## Context

ADR 0015 made a PID presentation the only way into the sandbox. Deploying the sandbox VM on
13 November 2026 showed what that costs a participant:

1. **The sandbox opens before any official PID exists.** The sign-in verifier accepts only test PIDs:
   - from the reference PID Providers, which anyone can obtain with made-up data;
   - from "PID (demo)".

   Every participant must still obtain one before seeing anything. Many will not have one, and
   should not need one to configure a service.
2. **Only the sandbox wallet build can sign in.** The sign-in verifier's access certificate comes from
   the sandbox Access CA. A wallet trusts an access certificate only from the Access CA anchors it
   holds (`AS-WP-06-005`, `RPA_04`), and the sandbox's are on no notified list. So:
   - the official Reference Wallet refuses the sign-in verifier, correctly;
   - so does the EDTP test wallet built for the demonstrations.

   A participant would have to install the modified sandbox build, and load a PID into it, before
   reaching the first page.
3. **Access already identifies everyone who reaches the portal.** ADR 0017 §2 puts the whole portal
   behind a Cloudflare Access application. Its policy names the invited participants' e-mail
   addresses, and a one-time PIN proves each address. Today the portal checks only that Access's
   header is present (`SANDBOX_PORTAL_REQUIRE_ACCESS`). The identity Access established is thrown
   away, and the person is identified a second time, by PID.
4. **Nothing ties the two together.** A person's account is a pseudonymous subject derived from the
   PID. It has no relation to the e-mail address the operator invited.

## Decision

### 1. The account is the e-mail address Access verified

- **Every request to the portal carries Access's signed assertion,** the `Cf-Access-Jwt-Assertion`
  header. The portal forwards it to the platform.
- **The platform validates it**, not the portal, so that a leaked `SANDBOX_PORTAL_SECRET` alone
  cannot mint an identity. It checks:
  - the RS256 signature, against the Access team's published keys (`/cdn-cgi/access/certs` on the
    team domain). The keys are cached, and refetched when an assertion names an unknown key id;
  - `iss`, equal to the configured team domain;
  - `aud`, containing the portal application's audience tag;
  - `exp` and `nbf`, with a small clock skew;
  - an `email` claim.
- **The plain `cf-access-authenticated-user-email` header is never trusted.** It is unsigned.
- **Configuration:** `SANDBOX_ACCESS_TEAM_DOMAIN` and `SANDBOX_ACCESS_AUDIENCE`. Neither is a secret.
  The platform refuses to start the sandbox without them, except as §7 allows.
- **The address is normalised**, trimmed and lower-cased. It is the person's unique key.

### 2. Sessions follow the Access identity

- The portal keeps its own session, as ADR 0015 Decision 5 decides: a `__Host-` cookie, 30 minutes
  idle, 8 hours absolute.
- **A session is valid only together with an assertion for the same address.** If the assertion is
  missing, invalid, or names another address, the session is ended. So removing someone from the
  Access policy, or Access's own session ending, takes effect at once.
- **Built as one guard** (`SandboxAccessGuard`) over every `/sandbox/v1/` route that carries a session
  and the portal's secret, so a route added later cannot forget it.
- **First visit:** a valid assertion for an unknown address creates the person, after they type a
  display name. Sign-up then continues as J1 does today: declaring the organisation.

### 3. The PID is optional

- **A signed-in person may present a PID** to the same sign-in verifier ("Present a PID"), under the
  same policy. ADR 0015 Decisions 2 and 3 apply unchanged:
  - a fixed anchor set, never the participant PID list;
  - five claims in, one pseudonymous subject out, no PID value kept.
- **The subject is recorded on the person,** and the portal shows "PID presented". One subject
  belongs to at most one person.
- **In v1 it gates nothing.** Configuring services, obtaining certificates and running the hosted
  verifier and issuer all work without it. What it is for:
  - trying the presentation flow from the user's side;
  - a later decision may make it a precondition for chosen actions.
- **The tests themselves still need a wallet.** A hosted-verifier run is a wallet accepting or
  refusing the sandbox's certificates, so a participant who runs one needs the sandbox wallet build.
  A participant who only configures does not.

### 4. Invitations name an address

- An owner invites a member by **e-mail address**. The invitation keeps the single-use link and the
  72 hours.
- The portal sends the token to the platform in a request body, never in a path a request log could
  keep.
- **It can be accepted only by the person whose verified address it names.** A forwarded link is
  useless to anyone else.
- **The sandbox sends no e-mail.** The owner passes the link on.
- The invitee must also be on the Access policy, which the operator keeps. The invitation page says
  so, and the operator sees pending invitations for addresses not yet on that policy.

### 5. The address is personal data, and is handled as such

- Stored once, in the person's record. It is deleted with the account.
- **Never in a log, an audit record or a run report.** Audit records name the person by id. `email`
  and `assertion` join the log redaction deny-list. An integration test proves that no address
  reaches a log or an audit record.
- **Never shown to members of another organisation.** Within an organisation, members see each
  other's display names and addresses.
- The portal's help text says what is kept: the address, the typed display name, and, if a PID was
  presented, the pseudonymous subject.

### 6. The operator is unchanged

- The operator's duties stay where they are: `sandbox-operator-cli.js` on the VM, and the Access
  policy in Cloudflare.
- No operator role is created in the portal by this ADR.

### 7. Without Access, on a laptop

- The laptop runs the sandbox without Access.
- **For that case only,** `SANDBOX_ACCESS_DEV_IDENTITY=<address>` lets the platform accept that one
  address without an assertion.
- **The platform refuses to start** if it is set together with the Access settings. The platform
  cannot see the portal's `SANDBOX_PORTAL_REQUIRE_ACCESS`, so this is the check it can make.
- **The sandbox VM's compose file requires the Access settings and never names the development
  identity.** The compose drift test checks both.
- Integration tests sign assertions with a key pair they generate, served as a local key set. No test
  disables the signature check.

### 8. No accounts to migrate

- The deployed sandbox has no participants.
- The migration adds `email`, unique, and makes `subject` nullable.
- A laptop database's PID-only people can no longer sign in. They are development data.

## Considered and rejected

- **Keep the PID mandatory.** Rejected by the user. It bars every participant without a test PID and
  the sandbox wallet build, at the first page.
- **E-mail and password, held by the sandbox.** A credential store, a reset flow and a second factor,
  all to repeat what Access already does.
- **Trust the unsigned `cf-access-authenticated-user-email` header.** Simple, and it holds only as long
  as nothing reaches the portal except through Access. One misrouted hostname would make it a
  sign-in-as-anyone. Validating the signed assertion costs one key fetch.
- **Validate the assertion in the portal only.** The platform would then trust whatever address the
  portal sends, behind a single shared secret.
- **Access as an OpenID Connect provider to the portal** (Access for SaaS). A second protocol surface
  for the same identity the assertion already carries.
- **Link the PID to the address automatically,** so that the first PID presentation "verifies" the
  account. A PID identifies a natural person, not their e-mail address or their organisation (ADR 0015,
  Context 2). Recording that both were presented by the same signed-in person is all the sandbox can
  honestly say.

## Consequences

- **Positive.**
  - An invited participant is in the portal with nothing but their e-mail address.
  - The sandbox can launch before any official PID exists, and before participants have installed
    anything.
  - Invitations reach the intended person.
  - Removing someone from the Access policy locks them out at once.
- **Negative.**
  - **The sandbox keeps e-mail addresses.** ADR 0015 kept only a pseudonym. The legal basis for
    keeping them is to be confirmed, as for every personal datum the platform keeps.
  - **Identity now rests on Cloudflare Access.** Leaving Access means another identity provider and a
    change to this ADR. The laptop's dev identity is not one.
  - **"Sign in with your PID" is no longer the sandbox's front door.** It becomes an optional
    demonstration of the same flow.
- **Unchanged:**
  - the sign-in verifier, its policy and its fixed anchor set;
  - the quotas and the operator's suspension;
  - every rule that no PID value reaches the database or a log.
- **Changed on acceptance** (done 14 November 2026):
  - ADR 0015's status line (amended by this ADR), and ADR 0017 §2;
  - the specification's §3 roles table, J1 and J2;
  - the portal's first screen and help text;
  - `security-limitations.md` SB15, which says Access only decides who reaches the portal;
  - `infra/sandbox-vm/` (two settings in `.env`, the compose file and its test);
  - the sandbox plan and `status.md`.
- **The code it needed**, built in PR #50:
  - assertion validation and key caching in the platform;
  - the people migration;
  - sessions bound to the assertion;
  - "Present a PID" as an action of a signed-in person;
  - invitations by address;
  - the redaction test.

  Then a deployment, which the user confirms.

## Open

1. **The legal basis for keeping participants' e-mail addresses**, with the rest of the personal data
   the platform keeps.
2. **Whether a PID presentation should later gate any action,** for example operating a hosted PID
   issuer. In v1 it gates nothing.
3. **When sign-up opens beyond invited participants** (ADR 0017 Open 2). With this ADR it means
   widening the Access policy, for example to any address with a one-time PIN. The quotas and the
   suspension are what limits it then.

## Status of claims

None. This is a `TEST` environment with synthetic data. It makes no claim of production readiness, and
no claim of conformance with ARF 3.0.0 or any Technical Specification. A PID presented in the sandbox
is a test PID. Any wallet result is a result of the **modified** EDTP sandbox wallet build, never "the
Reference Wallet".
