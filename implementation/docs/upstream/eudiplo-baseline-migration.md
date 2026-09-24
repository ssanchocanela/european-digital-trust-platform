# DRAFT — not filed

An upstream issue for [OpenWallet Foundation / EUDIPLO](https://github.com/openwallet-foundation/eudiplo),
drafted on 11 September 2026. **It has not been submitted.** Filing it is a human decision: it is
outward-facing, it names a project we only consume, and the report below should be read by someone
who can confirm we are not simply using the engine in a way its maintainers did not intend.

If it is filed, check first whether a later release already changed `BaselineMigration`, and whether
an equivalent issue is already open.

---

**Title:** `BaselineMigration` creates no schema, so a fresh deployment needs `DB_SYNCHRONIZE=true`
and cannot be migration-only

**Version:** `v7.6.0` (image digest `sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667`),
PostgreSQL 17.6

## What happens

Starting v7.6.0 against an empty PostgreSQL database with `DB_MIGRATIONS_RUN=true` and
`DB_SYNCHRONIZE=false` crash-loops at bootstrap:

```
QueryFailedError: relation "client_entity" does not exist
  at InternalClientsProvider.onApplicationBootstrap (dist/auth/client/adapters/internal-clients.service.js:40)
  code: '42P01'
```

Before that, the migration runner logs:

```
[Migration] Fresh database detected. Schema will be created by TypeORM synchronize.
[Migration] Ensure DB_SYNCHRONIZE=true is set for initial setup.
[Migration] key_entity table not found — skipping (schema may not exist yet).
[Migration] issuance_config table not found — skipping (schema may not exist yet).
... (every subsequent migration skips)
```

Only `config_resource_metadata`, `tenant_action_log` and `typeorm_migrations` end up existing.

## Why

`dist/database/migrations/1740000000000-BaselineMigration.js` creates nothing:

```js
async up(queryRunner) {
  const tables = await queryRunner.getTables(["tenant_entity"]);
  if (tables.length > 0) { /* mark baseline complete */ return; }
  console.log("[Migration] Fresh database detected. Schema will be created by TypeORM synchronize.");
  console.log("[Migration] Ensure DB_SYNCHRONIZE=true is set for initial setup.");
}
```

So the 45 migrations can evolve an existing schema but cannot establish one, and `DB_SYNCHRONIZE`
is load-bearing for first boot.

## Why it matters

`DB_SYNCHRONIZE`'s own description says *"Set to false in production after initial setup and rely on
migrations instead."* That is good advice, and it is exactly what cannot be followed from a clean
start: an operator who sets `false` from the outset — the natural reading of that guidance, and
standard practice for a production deployment — gets a crash loop whose message (`relation
"client_entity" does not exist`) does not point at the cause.

The practical consequences:

- **No reproducible provisioning.** A fresh environment cannot be brought up by migrations alone, so
  the schema for deployment *n* is whatever TypeORM inferred from the entities at that version,
  rather than a reviewed artefact. Two environments created at different versions can differ without
  anything recording it.
- **Infrastructure-as-code and CI friction.** Anything that creates a database and expects
  migrations to define it needs a bespoke two-phase step, and the phase boundary is manual.
- **It is self-inflicted precedent.** `v7.3.0`'s changelog records fixing "the session columns that
  no migration ever created" — the class of problem a real baseline migration prevents.

## Suggested fix

Replace the no-op baseline with a generated migration that creates the full schema as of the
baseline version, keeping the existing "existing database detected" branch so current deployments
continue to mark it complete. TypeORM can generate it from the entities, so it is largely mechanical:

1. Start an empty database with `DB_SYNCHRONIZE=true`, let TypeORM create the schema.
2. `typeorm migration:generate` against an empty database to capture it as SQL.
3. Put that in `BaselineMigration.up()` behind the existing `getTables(["tenant_entity"])` guard.

Then a fresh deployment works with `DB_SYNCHRONIZE=false`, and the documented guidance becomes
followable from the start.

### Smaller alternatives, if that is too large a change

- **Fail fast with a clear message.** If the baseline detects a fresh database and
  `DB_SYNCHRONIZE` is false, throw with the remedy in the message rather than letting a later
  bootstrap query fail on a missing table.
- **Document the two phases** in the deployment guide and next to `DB_SYNCHRONIZE`: `true` for the
  first start, `false` afterwards.

## How we work around it

We default the engine's `DB_SYNCHRONIZE` to `true` so a first `docker compose up` succeeds, document
the two phases, and tell operators to set it to `false` after the first successful start. The engine
runs against its **own** PostgreSQL instance, separate from our platform database, so its schema
management cannot affect ours.

## Not a complaint about migrations existing

To be clear: the engine does have a working migration mechanism and uses it. The gap is narrow —
there is no migration that establishes the initial schema, which makes the documented
"`false` in production" guidance impossible to follow from a clean start.
