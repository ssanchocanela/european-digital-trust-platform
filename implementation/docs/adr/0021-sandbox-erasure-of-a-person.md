# ADR 0021 — Erasure of a person from the sandbox

- **Status:** ACCEPTED, 15 November 2026, by the user, and built the same day (PR #57). **Not deployed
  yet.** Roadmap track R7, first item, in the order the user approved: erasure before any outside
  participant is admitted.
- **Date:** 15 November 2026
- **Answers:** [ADR 0019](0019-sandbox-operator-section.md) Open 1, "erasure of a person on request".
- **Follows:**
  - [ADR 0018](0018-sandbox-sign-in-by-access-identity.md) Decision 5: the sandbox keeps participants'
    e-mail addresses, so it must be able to forget them;
  - [ADR 0015](0015-sandbox-sign-in-by-pid.md) Decision 7: an organisation never loses its last owner.
- **Numbered 0021**, the next free number after 0020.

## Context

Since ADR 0018 the sandbox keeps personal data about each participant:
- the e-mail address Cloudflare Access verified;
- the display name they typed;
- if they presented a PID, a pseudonymous subject derived from it.

A person must be able to have it erased. That has to hold before anyone from outside is admitted.

**Where a person's data is**, read in the schema on 15 November 2026:

| Where | What | On erasure |
|---|---|---|
| `sandbox_people` | Address, display name, subject, timestamps | **Deleted** |
| `sandbox_memberships`, `sandbox_sessions`, `sandbox_sign_in_attempts` | The person's id | **Deleted** with the person (`ON DELETE CASCADE`) |
| `sandbox_invitations.created_by` | The person's id | Invitations they created are **deleted** (`CASCADE`) |
| `sandbox_invitations.accepted_by` | The person's id | **Cleared** (`SET NULL`) |
| `sandbox_invitations.email` | **Their address**, in invitations addressed to them | **Deleted**. There is no foreign key, so this must be done explicitly |
| `audit_events` | The person's id as subject, or in the actor `sandbox-operator:<id>`. **Never an address** (ADR 0018 Decision 5, tested) | **Kept.** Once the person is gone, an id points at nothing: the record keeps what happened without saying who |
| Logs | No address and no PID value (the redaction deny-list, tested) | Nothing to do |
| Run reports (`observation_note`) | The organisation's free text, which the portal says must hold no values | Kept: it is the organisation's |
| **Backups** | Hetzner's daily server images (7 kept); `deploy.sh`'s pre-deployment dumps (14 kept) | **Not edited.** The data ages out as backups rotate. The help text and the privacy notice (R8) say so |
| **Cloudflare Access policy** | The address, kept by the operator | **The operator removes it**, in the Cloudflare dashboard. The portal reminds them |

## Decision

### 1. Two ways in

- **The person themselves:** "Delete my account" on their dashboard, behind a confirmation page.
  Typing their own address confirms it.
- **The operator, on a request received another way** (for example, by e-mail): "Erase" on the
  person's row in `/admin/people`, behind a confirmation page and with a reason. The reason goes to
  the audit trail and must hold no personal data.

### 2. What erasure does, in one transaction

1. Deletes the invitations addressed to the person's address.
2. Deletes the person. The cascades remove their memberships, sessions and sign-in attempts, and the
   invitations they created.
3. Records `sandbox.person.erased` in the audit trail, with the person's id. No address goes there,
   and no name. The operator's reason is recorded when the operator erased the person.

The person's current session ends with it. On their next visit Access still admits them, unless the
operator has removed them from the policy, and they meet the first-visit page as a stranger.

### 3. Organisations: the last owner (the decision this ADR has to take)

An organisation must never be left without an owner (ADR 0015 Decision 7). The rule:

- **If the person is the last owner of an organisation that has other members,** erasure is
  **refused**. The page says to make another member an owner first. An owner can already invite one,
  and §4 adds "make owner" for an existing member. The operator can override it (below).
- **If the person is the organisation's only member,** the organisation goes with them. It is
  **suspended**, exactly as the operator's suspension does (specification J9): every certificate is
  revoked, its Wallet Provider anchors leave the list, and nothing more can be created. The
  organisation's own record stays, because certificates, CRLs and the register refer to it. Its data
  is organisational, not personal.
- **The operator's override:** when the operator erases a last owner who has other members, the
  organisation is suspended too. The confirmation page says so, and names the members who lose it.

The **only-member** case is suspension, not deletion. Deleting an organisation would leave revoked
certificates whose CRL entries and register history point at nothing. Organisations can be deleted
later, if a participant asks; that is not a person's erasure.

### 4. Making another member an owner

- An owner can make a member an owner, from the organisation's members table. It is audited.
- There is no demotion in v1. An owner who wants to leave removes themselves, which the last-owner
  rule already governs.

### 5. What the sandbox says, and to whom

- **The person sees, before confirming:**
  - what is deleted;
  - which organisations are suspended, if any;
  - that backups keep the data until they rotate: up to 14 days for the dumps, 7 for Hetzner's
    images;
  - that Access keeps admitting their address until the operator removes it.
- **The operator sees the same,** plus the reminder to remove the address from the Access policy.

## Considered and rejected

- **Anonymise the person instead of deleting them,** keeping the row with the address blanked.
  Nothing needs the row: audit records keep the id, and memberships and sessions have no purpose
  without a person. Deletion is simpler, and it is the stronger reading of erasure.
- **Delete the organisation with its only member.** It would leave certificates already issued, and
  their revocation entries, pointing at a vanished organisation.
- **Let the last owner leave and the operator inherit the organisation.** It makes the operator a
  member of participants' organisations, which ADR 0019 §4 rules out.
- **Edit backups.** Neither Hetzner's images nor the dumps can be edited selectively. Rotation is the
  honest answer, and it is stated.

## Consequences

- **Positive.** A person can leave and take their personal data with them, before the sandbox opens to
  outsiders.
- **Negative.** Erasure is final. An erased person who comes back is a new person, with no memberships.
- **Negative.** Backups hold the data for up to 14 days afterwards. This is stated, not hidden.
- **Changed on acceptance** (done 15 November 2026):
  - the specification (a journey for leaving);
  - `security-limitations.md` (the backup window);
  - the roadmap (R7's first item);
  - `status.md`.

## Open

1. **Deleting an organisation** on its participants' request: not decided here.
2. **The privacy notice** (R8) states the retention windows above. It is not written yet.

## Status of claims

None. This makes no claim of compliance with any data-protection rule. It is the sandbox's own
handling of the personal data it keeps, and the legal basis for keeping it is still open (ADR 0018
Open 1).
