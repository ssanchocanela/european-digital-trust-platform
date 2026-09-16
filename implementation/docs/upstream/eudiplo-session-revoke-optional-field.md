# DRAFT — not filed

An upstream issue for [OpenWallet Foundation / EUDIPLO](https://github.com/openwallet-foundation/eudiplo),
drafted on 16 September 2026. **It has not been submitted.** Filing is a human decision.

If it is filed, check first whether a later release fixed it, and whether an equivalent issue is
already open. This one is cheap to re-test: two `curl` calls, below, differing by one field.

---

**Title:** `POST /api/session/revoke` returns 500 when `credentialConfigurationId` is omitted, which
the API contract documents as allowed

**Version:** `v7.6.0`, image `ghcr.io/openwallet-foundation/eudiplo:7.6.0`
(`sha256:8dd60a2fe38f7c6f91b6a3c4003182fbb1a3659a5a7a697166ad0f0c5120c667`)

**Component:** `StatusListService.updateStatus`, reached from `SessionController.revokeAll`

## Summary

`StatusUpdateDto` marks `credentialConfigurationId` optional and documents what omitting it means:

```json
"credentialConfigurationId": {
  "type": "string",
  "description": "Optional credential configuration id. If omitted, all credentials linked to the session are updated.",
  "minLength": 1
},
"required": ["sessionId", "status"]
```

Taken from the running instance's own `/api/docs-json`, so this is the contract the server publishes.

Omitting the field returns **500**:

```
ERROR: [AllExceptionsFilter] [POST] /api/session/revoke 500 - "Internal Server Error"
  TypeORMError: Undefined value encountered in property 'StatusMapping.credentialConfigurationId'
    of a where condition. Set 'invalidWhereValuesBehavior.undefined' to 'ignore' in connection
    options to skip properties with undefined values.
      at SelectQueryBuilder.buildWhere (typeorm/query-builder/SelectQueryBuilder.js:2610:31)
      at EntityManager.findBy (typeorm/entity-manager/EntityManager.js:670:14)
      at StatusListService.updateStatus (dist/issuer/status-list/status-list.service.js:677:60)
      at SessionController.revokeAll (dist/session/session.controller.js:52:39)
```

The undefined property is passed straight into a `findBy` where-condition rather than being removed
when absent, so the documented "update all credentials for this session" path cannot be taken.

## Steps to reproduce

One session, one status, two calls that differ by one field.

```bash
# The documented optional path
curl -X POST "$ENGINE/api/session/revoke" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"sessionId":"<session>","status":1}'
# -> 500 {"statusCode":500,"message":"Internal Server Error"}

# The same call, naming the configuration
curl -X POST "$ENGINE/api/session/revoke" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"sessionId":"<session>","credentialConfigurationId":"<id>","status":1}'
# -> 204
```

Observed on a session in `completed` status whose credential the same instance had issued minutes
earlier. It reproduces for every value of `status`: `1` (revoked), `2` (suspended) and `0` (valid)
all fail identically without the field.

Expected: the status of every credential linked to the session is updated, as documented.
Actual: `500`, and nothing is updated.

## Why this is worth more than its size suggests

`POST /session/revoke` is the only exposed status mutation in the API. A deployment that follows the
contract — omitting an optional field — therefore finds that **revocation and suspension do not work
at all**, with a `500` that says nothing about which field is responsible. The 500 also gives a
caller no way to distinguish "the engine is unwell" from "this request cannot succeed and never
will", which matters for anything that retries.

## Suggested fix

Two independent changes, either of which resolves it:

1. Build the `where` condition from the fields that are present, so an absent
   `credentialConfigurationId` means "all credentials for this session" as documented — rather than
   `undefined` reaching TypeORM.
2. Failing that, make the field required in `StatusUpdateDto` and remove the sentence describing the
   omitted behaviour. A contract that promises a path should not have that path be the broken one.

The first matches the documented intent; the second at least makes the API honest.

## What this report does not claim

Nothing about the ARF or about conformance. It is a report about one release of one implementation,
observed on one afternoon, from a project that consumes EUDIPLO rather than reviews it. The
workaround — always sending the field — works, and the project has adopted it; the report is filed
because the contract's own documented path is the one that fails.
