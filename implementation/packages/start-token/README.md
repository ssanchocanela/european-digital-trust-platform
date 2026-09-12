# `@edtp/start-token`

The signed hand-off between the operator console and the public test-start page.

Its own package for one reason: **the minter and the verifier must never drift.** A signature scheme
copied into two applications is a bug waiting for the day someone changes the payload on one side.

It is a **test-harness artefact**, not a platform capability, and it is deliberately not in
`@edtp/shared`: nothing in the platform's domain or kernel depends on it, and nothing should. See
`docs/web-interface-proposal.md` §3.3 for why a publicly reachable page exists at all, and why it is a
signed-redirect service with no API credential.
