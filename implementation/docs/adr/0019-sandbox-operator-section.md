# ADR 0019 — The operator's section in the sandbox portal

- **Status:** PROPOSED, 14 November 2026. Drafted at the user's request, after the first real browser
  test of the deployed sandbox: "there should be an admin part".
- **Date:** 14 November 2026
- **Amends:** [ADR 0018](0018-sandbox-sign-in-by-access-identity.md) Decision 6, "no operator role is
  created in the portal".
- **Builds:** [`specification.md`](../sandbox/specification.md) J9, *Operator*, whose "see participants,
  quotas and the audit trail" S6 left to a command-line tool.
- **Follows:** [ADR 0015](0015-sandbox-sign-in-by-pid.md) Decision 7: the operator role exists outside
  every organisation and is held by configuration, not by sign-up.
- **Numbered 0019**, the next free number after 0018.

## Context

The sandbox is deployed and invited participants can enter it. Its operator, the person who runs it,
has no view of it.

- **What exists:** `sandbox-operator-cli.js` on the VM, with two commands:
  - `participants` lists the organisations;
  - `suspend` suspends one.

  The operator must reach the VM by SSH, and nothing shows the people, their invitations, the
  certificates issued, how close anyone is to a quota, or the audit trail.
- **Who may enter at all** is the Cloudflare Access policy. It is kept in the Cloudflare dashboard.
- **ADR 0018 Decision 6 kept the operator out of the portal** to keep that ADR small. Now that people
  are known by a verified address, an operator can be recognised the same way, so that reason no
  longer holds.

## Decision

### 1. Who is an operator

- **The operators are a list of addresses in the VM's configuration:**
  `SANDBOX_OPERATOR_EMAILS=a@…,b@…`. The list is normalised as people's addresses are. It is not a
  secret, but it lives in `.env`, not in the repository.
- **An operator is recognised by the verified Access identity**, on every request. They need:
  - the same signed assertion as everyone else (ADR 0018 Decision 1);
  - a sandbox account of their own: the first visit creates it, as for anyone.
- **Nobody becomes an operator through the portal.** No route grants or removes the role. Changing
  the list means changing `.env` and restarting the platform.
- **A second lock at the edge:** a Cloudflare Access application of its own on
  `sandbox.murcata.es/admin`, whose policy names only the operators. A path-specific application takes
  precedence over the portal's, so a participant is stopped by Access before the portal sees the
  request. The platform's check stays: the edge rule is defence in depth, not the rule.

### 2. What the section shows

Read-only pages under `/admin`:

| Page | Shows |
|---|---|
| **Overview** | Organisations (active, suspended), people, pending invitations, certificates issued and revoked, runs and PID offers in the last 24 hours |
| **Organisations** | For each: `SB:` identifier, legal and trade name, country, declared EUID, status, created, members, services, certificates. Quota use against `SANDBOX_QUOTAS`, for each quota |
| **An organisation** | Its members with their addresses and roles; its services; its certificates (variant, status, expiry); its hosted verifier and issuer; its pending invitations |
| **People** | Address, display name, created, last sign-in, whether a PID was presented, organisations |
| **Invitations** | Pending ones: organisation, invited address, role, expiry. The operator can see who still has to be admitted in the Access policy |
| **Audit trail** | The platform's audit records for the sandbox, newest first, filterable by organisation. Actions and ids only, as audit records already are |

- **No PID value, no key, no token is shown,** because none is kept.
- **What a participant sees is not changed.**

### 3. What the operator can do

In v1, only actions the specification already gives the operator, each with a confirmation page and
an audit record:

- **Suspend an organisation,** with a reason. It does what `sandbox-operator-cli.js suspend` does today:
  - every certificate is revoked;
  - nothing more can be created for the organisation;
  - it is final in v1.

  The command-line tool stays, as the fallback when the portal is down.
- **Revoke a pending invitation.**
- **End a person's sessions,** for example after removing them from the Access policy. ADR 0018 Decision 2
  already ends a session at the person's next request; this ends it at once.

### 4. What it will not do

- **Edit the Access policy.** That would put a Cloudflare API token with write access on the VM.
  Admitting someone stays a step in the Cloudflare dashboard. The invitations page lists who is waiting
  for it.
- **Act as a participant.** There is no "sign in as" and no editing of an organisation's services or
  certificates.
- **Change quotas, rotate sandbox keys, approve brought-in anchors.** These are J9 duties for later.
  Key rotation stays an operator action on the VM, and anchors are v1.1.
- **Delete a person.** Erasure on request is a real need: the sandbox keeps addresses. Deleting someone
  interacts with last-owner rules and audit records, though, so it is decided separately (Open 1).

### 5. How it is built

- **Platform:** `/sandbox/v1/admin/*` routes. They pass the same guard as every portal route (a
  session together with an assertion for the same address). Then an operator check runs: the
  session's person's address must be on `SANDBOX_OPERATOR_EMAILS`. Anyone else gets `404`, so the
  section does not reveal that it exists.
- **Audit:** every operator action is recorded with the operator's person id as the actor, never an
  address, as ADR 0018 Decision 5 requires.
- **Portal:** `/admin` pages, the same look and the same rules: CSP, origin check, no script. An
  "Operator" link appears on the dashboard for operators only.
- **Checks:** the scheduled negative checks gain `/admin`. Publicly it must redirect to Access; on
  loopback, without the header, it must be `403`.
- **Tests:**
  - a non-operator, and an operator's address with a mismatched assertion, get `404` on every admin
    route;
  - suspension through the portal does what the command-line tool does;
  - no address reaches a log or an audit record.

## Considered and rejected

- **Keep the command-line tool only.** It works. But nobody can see the sandbox's state without SSH
  and a terminal, and J9 asks for the operator to see it.
- **A separate admin application on its own hostname.** A second process, a second Access application
  and a second deployment, for a handful of pages that need the same session and the same platform.
- **Operator as a flag in the database, granted in the portal.** A role that the portal can grant is a
  role that a portal bug can grant. Configuration cannot be changed from a browser.
- **The Cloudflare API from the VM, to manage the Access policy.** It would put a write token for the
  edge that protects the sandbox on the machine it protects.

## Consequences

- **Positive.**
  - The operator sees participants, people, invitations, quota use and the audit trail in a browser.
  - The operator can suspend without SSH.
  - The specification's J9 "see" is met.
- **Negative.**
  - **A new privileged surface.** Every admin route is one more place where a mistake shows one
    participant's data to another person. The `404`-for-non-operators rule and its test are what stand
    between.
  - **The operator sees every participant's address.** The portal's help text says so.
  - **One more Access application** to keep in step with `SANDBOX_OPERATOR_EMAILS`. They are two lists
    of the same people. If they drift, the stricter one wins, which is safe but confusing.
- **To change on acceptance:**
  - ADR 0018 Decision 6;
  - the specification's J9;
  - `infra/sandbox-vm/` (`.env`, the README's Access step, the negative checks);
  - `security-limitations.md`;
  - the sandbox plan and `status.md`.

## Open

1. **Erasure of a person on request.** It must remove their address and display name. It must also
   decide what happens to organisations where they are the last owner, and keep audit records
   meaningful.
2. **Quota changes per organisation**, for a participant who needs more.
3. **Whether the overview should alert,** for example through the operator's ntfy topic, when an
   organisation nears a quota.

## Status of claims

None. This is a `TEST` environment with synthetic data. It makes no claim of production readiness, and
no claim of conformance with ARF 3.0.0 or any Technical Specification.
