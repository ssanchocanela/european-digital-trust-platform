# The credential catalogue, and where each entry comes from

What a Relying Party Service may ask for in this deployment, and — more importantly — **how well each
entry is known**. Written 13 September 2026.

Registered by [`scripts/register-credential-catalogue.mjs`](../scripts/register-credential-catalogue.mjs),
which records what a registration *would* authorise so the platform can be built and operated.
**It registers nothing with a Registrar, and nothing it writes is evidence that any authority
authorised anything.** `TEST` environment only.

| Credential | Format | Identifier | Source | Confidence |
|---|---|---|---|---|
| PID | `dc+sd-jwt` | `urn:eudi:pid:1` | the live reference issuer's own metadata | **exact** |
| mDL | `mso_mdoc` | `org.iso.18013.5.1.mDL` | the same | **exact** |
| Power of Representation | `dc+sd-jwt` | `urn:edtp:pox:power-of-representation:1` | a consortium Rulebook draft (v0.1) | attribute names exact, **structure and identifier interpreted** |
| Power of Attorney | `dc+sd-jwt` | `urn:edtp:pox:power-of-attorney:1` | the same | as above |
| Power of Employee | `dc+sd-jwt` | `urn:edtp:pox:power-of-employee:1` | the same | as above |
| Large Family Title | `dc+sd-jwt` | `urn:edtp:large-family:1` | this project's own model | **ours, a working model** — no Rulebook exists |
| Income certificate | `dc+sd-jwt` | `urn:edtp:income-certificate:1` | this project's own model | **ours, a working model** — no Rulebook exists |

## The first two are read, not remembered

PID and mDL claim paths come from `credential_configurations_supported` at the reference issuer,
fetched on the day they were registered. Typing them from memory would risk a policy that asks for an
attribute no wallet in this environment holds — a request that fails at the phone, for a reason that
looks like a wallet problem.

**One difference between them is worth knowing before writing any age policy.** The mDL carries
`age_over_18`; the PID does not, because the PID Rulebook removed age verification attributes
following CIR 2024/2977 and the live issuer advertises none. So the same question takes two different
policies: against an mDL, ask for the attribute; against a PID, request `birthdate` and derive, with
the date discarded in the same call stack. `CLAUDE.md` §6.1 and
[ADR 0005](adr/0005-presentation-policy-abstraction-and-minimisation-first-compilation.md) Decision 5.

## Power of X — referenced, not reproduced

Three attestations of a person's authority to act for a legal entity: **Power of Representation**
(a position held in an official register), **Power of Attorney** (an authority granted) and **Power of
Employee** (affiliation and what the company authorised). Format **SD-JWT VC**.

**Their definitions are not in this repository.** They derive from a consortium Rulebook draft
supplied to this project, and its content stays outside — the registration script loads them from a
file the operator supplies:

```
EDTP_POX_CATALOGUE=~/.edtp/credential-catalogue/pox.json
```

Without it the script registers PID and mDL and says what it skipped. It never invents the missing
entries: a catalogue that quietly registered something different from the Rulebook would be worse
than one that registered less.

### Two things in that file are this project's, not the Rulebook's

Recorded here because they are decisions, and because they are the ones that will have to change.

**1. The claim paths are an interpretation.** The Rulebook names its attributes and gives each an
encoding and an optionality, but provides **no JSON schema**. The paths in the catalogue file are a
straightforward reading of those names, and a reading is what they are.

**2. The credential type identifiers are ours.** The Rulebook specifies SD-JWT VC but **names no
`vct`**. One had to exist for anything to be registered, so the catalogue uses project-scoped values
under `urn:edtp:pox:`, deliberately not authoritative-looking — inventing something that resembled an
official identifier would hide the gap rather than record it.

**A Rulebook that specifies SD-JWT VC without naming a `vct`, and describes attributes without a
schema, is incomplete for implementation.** That is not a criticism of a draft; it is the state it is
in, and it is why both readings are written down rather than left in a file.

### What changes when the schema arrives

The claim paths, and therefore every presentation policy built on them. A published policy version is
immutable, so those policies do not silently change: they stay as published, keep working against the
credential they were written for, and a new version has to be published against the new paths. The
cost of getting this wrong is republication rather than an edit.

## Issuing Power of X — the `:2` model

Written 23 September 2026. The catalogue above describes what may be **requested**; this is how the
three attestations are **issued**, and it moved them to a new structure.

**A new model, so new identifiers.** The `:1` catalogue read the Rulebook's attribute names as flat
paths and had no place for a repeated group — a Power of Attorney's powers are a list, each with its
own fields — nor for the rules between blocks: a proxy is a person *or* an organisation, never
both; constraints exist only when a limitation is declared; code lists are integers. The issuance
model keeps the Rulebook's attribute identifiers as claim paths, carries each repeated group as one
`object[]` claim, and states the rules as a JSON Schema the platform enforces before issuing. The
types are `urn:edtp:pox:power-of-representation:2`, `…:power-of-attorney:2` and
`…:power-of-employee:2`. Still this project's interpretation, still no `vct` from the Rulebook.

**Still outside the repository.** The claim definitions, the schema and the test data are read from
`~/.edtp/credential-catalogue/` by
[`scripts/register-pox-issuance.mjs`](../scripts/register-pox-issuance.mjs), which creates the three
credential types, a published issuance policy for each, and an identification policy that asks the
PID for what a natural-person proxy must carry — names, date of birth, nationalities, country of
birth. What the repository holds is generic: the `integer` and `object[]` value types and the
`payloadSchema` a credential type may carry.

**What an issued one contains.** The proxy's identity comes from a PID presentation the platform has
just verified. **Everything else is fictitious**: the organisation, the position, the powers, the
grantor and the evidence exist nowhere, the source is a FIXTURE, and every issuance says so.

**Three things it does not do**, each a Rulebook question recorded with the model:

- **Expiry linked to a position or a power** is not computed per attestation — validity is the
  Rulebook's standard two years. The test data holds nothing that ends sooner.
- **The elements of a repeated group are not individually disclosable.** A verifier asking for one
  power's faculty receives the whole list (`interop-findings.md` A32).
- **A PID without a country of birth cannot be used**: the Rulebook makes the place of birth
  mandatory for a natural-person proxy, and the platform refuses rather than inventing one.

A presentation policy on the `:1` catalogue does not match a `:2` attestation. **Verifying a `:2` one**
takes three things, all in place since 23 September 2026:

- an intended use registering the `:2` identifiers — `register-credential-catalogue.mjs` with the `:2`
  catalogue file, generated from the issuance definitions so the paths cannot drift;
- a policy per type, from [`scripts/register-pox-presentation.mjs`](../scripts/register-pox-presentation.mjs),
  asking only for claims every issued attestation carries — a DCQL query naming an absent claim
  matches nothing, and the wallet then says it holds no suitable credential;
- an issuer trust anchor, because since A30 a policy naming none is refused: the **EDTP TEST list of
  non-qualified EAA providers** (`make-test-lote.mjs --kind eaa`), one anchor — the development
  attestation provider's self-signed certificate — published on the project's GitHub Pages, loaded
  into the engine as `edtp-test-eaa-providers`. Not notified; its type identifiers are ours.

**An attestation is verifiable only while its status list is reachable.** Its status list URI is the
engine's public URL at the time of issue, so attestations issued through a quick tunnel cannot be
verified once that tunnel closes. Issue through the named tunnel (`test-session-gateway.md` §2).

## The Large Family Title — a model of our own

Written 28 September 2026. *Título de Familia Numerosa*: the title a Spanish autonomous community
issues under Ley 40/2003 and Real Decreto 1621/2005, as a demonstration attestation. **No EU or national
Rulebook defines it**, so the model is this project's, and — unlike the Power of X definitions, which
derive from a confidential draft — it lives in the repository:
[`scripts/large-family/large-family-title.json`](../scripts/large-family/large-family-title.json).

**One attestation per family member**, like the individual title or card a community issues: the member
identified by the PID. Twelve claims, all selectively disclosable:

| Block | Claims | Where the value comes from |
|---|---|---|
| Member | `family_name`, `given_name`, `birthdate`; `member_role` (`holder` / `beneficiary`) | names and date of birth from a verified PID; the role fixed |
| Title | `title_number`, `category` (`general` / `special`), `number_of_children`, `date_of_issuance`, `date_of_expiry` | fixed, fictitious |
| Issuer | `issuing_authority`, `issuing_region`, `issuing_country` | fixed, fictitious; `ES-XX` is deliberately not an ISO 3166-2 code |

The attestation is valid for a year, shorter than the title's own `date_of_expiry`: it may expire
before the title, never after it. Revocation only, no suspension.

**Issued by its own issuer**, engine tenant `fam-1`, "Comunidad Autónoma Demo" — a fictitious
community, not a client's look, so it wears its own neutral brand on public hosts too. The flow is the
representation credentials': the wallet's own list (WD-5, now with a third issuer), identification with
the PID mid-issuance, a page showing what the title will state, issuance. Set up with
`scripts/setup-large-family-issuer.sh` and `scripts/register-large-family.mjs issuance`.

**Verified by Fibra Demo**, a fictitious fibre operator in the bank's process at `/fibra`, which offers
a 30% discount. Its policy asks for `category` and `date_of_expiry` and nothing else — the DCQL query
sent to the wallet was checked — and the page applies its own rule on the title's expiry. Created with
`register-large-family.mjs presentation`, under a **new** intended use. The wallet names the bank as the
Relying Party (security limitation P10).

**Trust.** `fam-1` signs with a self-signed certificate, like `rpi-1`, so the EDTP TEST list of EAA
providers now carries two anchors (`make-test-lote.mjs --ca a.crt,b.crt`). A title is verifiable only
once that list is republished and reloaded.

## The income certificate — a second model of our own

Written 5 October 2026, for Banco Horizonte's loan. What an employer's payroll could attest for a
lender: who employs the person, on what contract, since when, and what they are paid net each month.
**No Rulebook defines it.** The model is this project's and lives in
[`scripts/income/income-certificate.json`](../scripts/income/income-certificate.json), the same
structure as the Large Family Title's and read by the same script
(`EDTP_ATTESTATION_DEFINITION=… node scripts/register-large-family.mjs`).

| Block | Claims | Where the value comes from |
|---|---|---|
| Holder | `family_name`, `given_name`, `birthdate` | a verified PID |
| Employment | `employer_name`, `contract_type` (`permanent` / `temporary`), `employed_since` | fixed, fictitious |
| Income | `net_monthly_income` (whole euros) | fixed, fictitious |
| Issue | `date_of_issuance`, `issuing_country` | fixed |

Valid for 90 days: a lender wants a recent one. **Every holder gets the same employer and the same
salary**, so the attestation proves the platform can issue and verify this structure and nothing about
anyone's income.

**Issued by its own issuer**, engine tenant `nominas-1`, "Nóminas Demo", a fictitious payroll
provider with a neutral brand of its own. Set up with `scripts/setup-income-issuer.sh`. For the
wallet's own list to offer it, the test wallet needs a fourth WD-5 issuer (W9).

**Verified by Banco Horizonte**, as the loan's second presentation — a V0 policy asks for one
credential, so the PID and the certificate are two requests. Its policy asks for the income, the
contract type and the seniority, and for the holder's names and date of birth: not to learn them, the
PID already gave them, but because nothing else ties the second presentation to the first person. The
employer is not asked for. The page compares the two results; a production lender would do that in its
back end.

**Trust.** `nominas-1` signs with a self-signed certificate, so the EDTP TEST list of EAA providers
gains a third anchor, and must be republished and loaded on `horizonte-1`.

## Adding to the catalogue

Register a new intended use; do not edit an existing one. An intended use records an authorisation,
and a policy already published against it was validated against what it said at the time. Editing one
retroactively changes what a past policy is claimed to have been checked against.

```bash
PLATFORM_TENANT_API_KEY=… node scripts/register-credential-catalogue.mjs <serviceId> [identifier]
```
