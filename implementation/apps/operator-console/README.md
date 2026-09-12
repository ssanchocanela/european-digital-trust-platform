# Operator console

A server-rendered web interface for driving and observing the platform. Two processes:

| | | |
|---|---|---|
| `apps/operator-console` | `:3200`, **localhost only** | The operator's screens. Holds a tenant API key |
| `apps/test-start` | `:3201`, **publicly reachable** | One page. Holds no API credential |

Design and the decisions behind it: [`docs/web-interface-proposal.md`](../../docs/web-interface-proposal.md).

## What exists today

**Phase A — the test driver.** It starts one presentation and follows it to a terminal state, which is
what a wallet test needs and what was previously done with `curl` plus a hand-made QR. That is not a
convenience: a mistyped URI or a mistimed poll produces a failure that looks like a platform or wallet
failure, which is exactly what a run sheet exists to distinguish.

Not built yet: the operator console's other screens (phase B), which are mostly blocked on **list
endpoints the API does not have** — every route is `POST` or `GET` by id. The test driver needs none of
them.

## Running it

```bash
# With the stack up. Both services are optional and neither is started by default.
docker compose up -d operator-console
open http://127.0.0.1:3200
```

For same-device on a phone, also start the public page and set `TEST_START_PUBLIC_URL` to the origin the
**phone** will reach:

```bash
docker compose up -d test-start
```

Cross-device (`QR`) needs neither: the QR carries the OpenID4VP request and no page of ours is involved.

Configuration is documented in [`.env.example`](../../.env.example) under *web interface*.

## The two flows, and why one QR is not the other

This distinction matters for a run record, and it is easy to get wrong.

| Mode | What the QR carries | Where the wallet opens |
|---|---|---|
| `QR` (cross-device) | The **OpenID4VP request** (`openid4vp://…`) | On the phone, against a browser on the laptop. This is the flow ADR 0009 covers and the caveats apply |
| `SAME_DEVICE` | **Our HTTPS start page**, carrying a signed token | On the phone, against the browser on the *same* phone |

So a same-device run also uses a QR — to get the link onto the phone — but the OpenID4VP flow is
same-device. The console says so on the page, because recording it as cross-device would misstate which
path was tested.

## Security properties worth knowing before changing anything

| | |
|---|---|
| The tenant API key never reaches the browser | It lives in the console process. Every platform call is server-to-server, through named actions — there is no generic `request(path)` helper, because that is how a console becomes an open relay |
| No raw-response view | Not behind a flag, not for debugging. The result panel shows exactly what the result policy emitted. The moment a raw view exists, someone screenshots a PID |
| Escaping by default | `html.ts` is a tagged template that escapes interpolations; `rawHtml(` is the single searchable escape hatch. A restrictive CSP with no inline script is the second line of defence |
| Nothing in browser storage | No `localStorage`, no `sessionStorage`. The poller holds nothing |
| One piece of server state | The interaction URI, for ten minutes, because `GET /v1/presentations/{id}` does not return it. Bounded and expiring — see [`src/interaction-cache.ts`](src/interaction-cache.ts) |
| The public page can only redirect | No credential, no database, no session. A signed token carries the URI; wallet schemes only, so it cannot become an open redirector |
| The console refuses to bind off-localhost | Unless `CONSOLE_ALLOW_NON_LOCAL_BIND` is set, which the compose service does because the container boundary keeps it local |

## A defect this found

Building it turned up a platform bug worth recording: **`GET /v1/presentations/null` reached the
database** and produced a `500` with the whole SQL statement in the log. Path segments were the one kind
of input not validated — body fields are parsed by zod with `.uuid()`. Fixed with `assertUuidPathParam`,
applied to the presentation and issuance routes, and covered by `tests/unit/path-params.test.ts`.

It was found because a browser-facing client passes a path through verbatim, which is the sort of thing a
console does and a well-behaved script never does.

## Testing

The parts that carry weight are unit-tested without a server, which is why the views are pure functions:

| | |
|---|---|
| `tests/unit/start-token.test.ts` | Forgery, expiry, replay, and the scheme allow-list that keeps the public page from becoming an open redirector |
| `tests/unit/console-rendering.test.ts` | Escaping, the status payload adding nothing the API did not return, and the cache's bounds |
| `tests/unit/path-params.test.ts` | The validation gap above |

There is no browser-level test. Both flows were driven end to end by hand against the live stack —
cross-device, same-device, the public page, a replayed link (`410`) and the poller — and that is what the
current claim rests on.
