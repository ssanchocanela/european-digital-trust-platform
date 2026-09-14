# PR #6 — web interface, a wallet that works, and what running it live found

*Applied to PR #6 on 13 September 2026. Kept here so the description is versioned with
the branch it describes, and so a later edit has a source rather than being typed into a web form.*

**Branch** `implementation/web-interface` → `implementation/platform-v0-issuance`
**46 commits · three migrations, two of which change data**

---

## What this is

The web interface phases A and B1, the test-session tooling, a self-built wallet that completes a
presentation against the platform — and, because those things finally exercised the stack live, a
run of defects that no test able to be written beforehand could have caught.

That last part is most of the value here and it is worth saying plainly: **six of the defects fixed
in this branch were invisible to a passing test suite.** Each needed a real engine, a real wallet, or
a real database to show itself. The pattern is consistent enough to be the review's organising
question — *which layers has this branch newly made reachable, and what did they turn out to be
doing?*

## Read these three things first

Everything else in the diff is ordinary. These are not.

### 1. Migration 0006 changes data, and the change is not reversible by re-running it

`0006_engine_tenant_per_provider.sql` adds a unique index so one engine tenant serves one Attestation
Provider. Existing databases violate it — the development database held **four** providers on the
same engine tenant, which is the defect rather than a migration inconvenience.

The migration keeps the most recently created provider and **sets `engine_tenant_ref` to NULL on the
rest**.

The reasoning, which belongs in the review rather than only in the file: only one provider's
configuration is actually present in the engine — whichever wrote last — so for every other provider
the stored reference was *already false*. Clearing it makes the record agree with reality, and
issuance from those providers then fails with `attestation_provider_not_provisioned`, which names the
real problem. The alternative, refusing to migrate, leaves a platform that will not start and an
operator with no tooling to resolve it.

**This is a `TEST`-only V0 (`CLAUDE.md` §7). The choice would deserve revisiting before any
deployment holding data someone depends on.** If the reviewer disagrees with it, this is the line to
disagree on.

### 2. Two new outward-facing routes

| Route | Why it exists |
|---|---|
| `GET /v1/me` | Returns the tenant the presented credential belongs to. Every tenant-scoped route already *checks* the path parameter against the credential, so the parameter carries no authority; without this route a client has to be told its own tenant id by configuration, which drifts out of step with the key beside it and fails as a `403` that reads like an authentication bug. It discloses nothing — the caller is told the identity of the credential it already holds. |
| `DELETE …/attestation-providers/{id}/provision` | Releases an engine tenant so another provider can be given it. Required by the constraint in 0006: without it, the first provider to claim an engine tenant holds it for the life of the database, and one registered by mistake makes that tenant permanently unusable. A constraint with no way back is a defect, not a safeguard. |

Both sit behind the global API-key guard; `DELETE` additionally goes through `assertTenantMatches`.
Verified against the running stack: unauthenticated and mis-authenticated calls to `/v1/me` both
return `401`.

### 3. List endpoints make enumeration possible for the first time

Every route before these took an identifier the caller already held. A list is the first way to ask
"what is there", and the decision is deliberate rather than a convenience added for a screen —
`docs/web-interface-proposal.md` §5.

Two rules are enforced in the repository rather than left to each caller: **every query is scoped by
`tenantId` in its `WHERE`**, and **a presentation list item carries no result**. Enumerating
transactions is an operational need; enumerating *results* is a bulk read of the most sensitive thing
the API emits, and `AS-RP-01-002` (`OIA_16`) binds the platform as the Relying Party Instance.

---

## The defects that only a live run could find

| | What it was | How it surfaced |
|---|---|---|
| **A18** | The verifier adapter read `verifiedClaims`, a field the engine does not have. It survived 21 contract tests because **no test without a wallet can produce a verified presentation**, so the field was empty in all of them — and an empty field is indistinguishable from an absent one. | The first completed presentation |
| **A20** | The engine's issuer configuration is *tenant*-scoped; the platform wrote three of its fields per credential type, on every issuance. Each overwrote the last. Recorded as authorization servers alone; it was also the Credential Issuer's **wallet-visible name** (the stack announced an issuer called "Employee badge") and the registration certificate, which is trust gate (a). | Exercising §7.3 for the first time |
| **A22** | The §7.3 eligibility presentation was provisioned on the Relying Party Instance's engine tenant, lazily, with *that party's* access certificate, while the issuer resolved it on its own. All three worked only because one engine tenant served both roles on the development stack. | Tracing how to close A21 |
| **gate ⨯ flow** | A policy gated on a presentation was accepted with `PRE_AUTHORIZED_CODE`, which skips the authorization server by construction — the gate could never run, and the credential would have been issued without it. Separately, the offer did not name its authorization server, so the engine chose the built-in one and a gated policy produced an offer pointing away from its own gate. | A wallet run |
| **A23** | The verifier and the issuer named the same engine presentation configuration, so on a tenant serving both roles they wrote one object with different access keys. After an ordinary presentation, the issuer's eligibility request would have been signed by the **Relying Party** — a Wallet told a different organisation was asking. | Reviewing what A21 had left |
| **409 → 500** | The database driver stopped rethrowing the integrity error and started wrapping it, so the code was never found and every constraint violation became a generic `500`. `CLAUDE.md` §6.15 described behaviour that no longer happened. | Colliding with a uniqueness rule while testing something else |

That is six, not five — A23 was found reviewing the branch for this description, and it is the third
time in one day that the same pattern produced a defect: **one tenant-scoped engine object with two
owners.** A reviewer looking for a seventh should look there.

The tests added with each are written to fail the way the defect failed. The one for the `409`
provokes a **real** duplicate insert, because a test that hand-built the error shape would have
passed throughout the regression and would pass again the next time the driver changes.

## What the wallet results do and do not show

A modified wallet completed a full presentation: policy to DCQL, signed request object over public
HTTPS, encrypted response, verification, result policy, derived claim — `VERIFIED`, with
`{"over_18": false}` and no date of birth in the result.

**Every wallet result in this branch comes from a build we modified ourselves.** Never "the Reference
Wallet". The builds carry `BuildConfig.EDTP_DEVIATIONS`, name their deviations in a banner on every
screen, and `build.sh` refuses a deviation flag it cannot honestly honour — `wd-1` is refused outright
because it needs a published list of issuer anchors that does not exist.

Three statements this branch does **not** support, and which no document in it makes:

- that an *unmodified* wallet would accept our certificates — it would not, which is the entire
  reason the modified build exists;
- that ARF §6.6.2.2 gate (a) is satisfied. The W4 build accepts unsigned issuer metadata, which
  **bypasses** the gate. The same deviation silently switches off the issuer registration-certificate
  check, so nothing here evidences `AS-AP-44-005` (`RPRC_22a`) or `AS-AP-44-007` (`RPRC_23`) in either
  position of the wallet's preference;
- that the §7.3 eligibility presentation works against a wallet. It remains unexercised: after the
  fixes above the platform emits a correct, reachable gated offer and the wallet stops without a
  request or a logged error. Recorded in `reference-wallet-testing.md` §8.1d as what it is.

## Blockers

**B7 moved from inferred to observed.** The wallet refused on screen — *"the provider could not be
verified by your Wallet. Your personal information has not been shared"* — having requested the
metadata as `Accept: application/jwt; application/json`, which is finding A15 in a single header.

**B5 is closed operationally.** A tunnel in front of the default-deny path allow-list, with fourteen
negative checks that must return `404` and not `401` before any wallet interaction — a `401` would
prove the management API reachable.

**B1 is unchanged and now has two independent causes.** A self-signed access certificate cannot work
(`AS-WP-06-005` / `RPA_04`), and the route to obtaining a real one is closed: the reference Registrar
reports `201 … created successfully`, returns a `null` id, and persists nothing (C10).

## One correction to a documented fact

`hash_pid` identifies the **wallet installation**, not the person — four measurements, `C11`. The
runbook previously inferred, from an inconclusive run, that it tracks the PID's attributes. Both
practical conclusions invert: re-issuing the PID is safe and the values typed into the issuer's form
are irrelevant, and the wallet installation is irreplaceable by measurement rather than by suspicion.

This matters operationally: the PID behind the live registration expires **11 December 2026** and can
now be renewed without ending it.

## Verification

```
pnpm verify        282 unit, 115 integration
pnpm test:adapter   27 against a live engine (separately skippable; needs a container)
```

The adapter suite is where the engine's behaviour is pinned. Several of its tests read the
**wallet-facing** documents — `.well-known/openid-credential-issuer` — rather than the management API,
because that is the document the A20 defect was invisible in and what a wallet actually reads.

## Not production ready

V0 operates in the `TEST` trust environment only. No conformance to the ARF or to the Technical
Specifications is claimed anywhere in this branch, and `docs/security-limitations.md` lists the
shortcuts.
