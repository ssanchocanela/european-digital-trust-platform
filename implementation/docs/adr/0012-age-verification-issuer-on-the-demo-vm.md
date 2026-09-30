# ADR 0012 — The age verification issuer on the demonstration VM

- **Status:** PROPOSED, 30 September 2026. Accepted when the user approves the first deployment that
  brings the issuer up, and the Age Verification app issues from it.
- **Date:** 30 September 2026
- **Extends:** [ADR 0011](0011-age-verification-demos-on-the-demo-vm.md), which moved the verifier and the
  demos; this moves the other half.
- **Numbered 0012**, the next free number.

## Context

The Age Verification app issues its Proof of Age from `https://issuer-dev.murcata.es`: Keycloak as the mock
eID, the issuer, the status list and `age_verification_platform`'s own wallet provider, which the installed
app asks for a wallet and a key attestation before every issuance. That stack ran on a laptop behind the
`av-dev` tunnel, so it existed only while the laptop was on, and its routing sent Keycloak's admin console
to the internet behind the default password (found and closed on 30 September 2026; that repository's
PR #10).

The VM was resized from cx23 to cx33 (8 GB) the same day for this: the stack uses about 1.5 GB.

## Decision

1. **Same VM, a compose project of its own, `av-issuer`** (`infra/demo-vm/av-issuer/`), with the laptop
   stack's service names, which its haproxy routes by. Every image carries its configuration, because the
   repository is private and the VM cannot clone it (that repository's `deploy/issuer-vm/`); the VM pulls
   them with the same read-only ghcr login as the verifier's.
2. **The same hostname, `issuer-dev.murcata.es`**, moved from the laptop's tunnel to the VM's, so the app
   and every attestation and status list URI it already holds keep working unchanged.
3. **The laptop's TEST keys** (`issuer.p12`, `wallet-provider.p12`) are copied to `~/.av/issuer-pki` on the
   VM, not regenerated: the attestations already issued stay valid and the verifier trusts the same
   Document Signer. The Keycloak admin password is random, in `~/.av/issuer.env`, never the vendored
   default, which the Keycloak image no longer carries.
4. **Keycloak's admin console and API and the master realm are closed twice**: the tunnel publishes only
   the paths a wallet and a browser use (the issuer's realm, the login page's resources, the issuer, its
   well-known documents, the status lists, the wallet provider), and haproxy refuses them to anything but
   localhost. The counter path's internal API is refused by its own rule. The negative checks probe both.
5. **Keycloak keeps its data** in a volume, and a one-shot container applies `configure-keycloak.sh` after
   every deployment, so a recreation no longer loses the configuration.
6. **One deployment for both halves.** `deploy-av <tag>` deploys the demos and, once `~/.av/issuer.env`
   exists, the issuer, from the same commit; if either fails, both go back.

## Consequences

- The mock eID's test users (`adulto-test`, `joven-test`, `minor-test`, `nino-test`, `tneal`) have the
  password `password`, and so anybody on the internet can obtain a TEST Proof of Age of any of those ages.
  That is the demo; security limitation P12 states it.
- The wallet provider issues wallet and key attestations without validating the platform, as it does on the
  laptop (that repository's ADR-0021): anybody can obtain one.
- The private signing keys of the TEST issuer and wallet provider now live on the VM as well as on the
  laptop. They are TEST keys; rotating them means re-issuing and updating the verifier's trust store.
- The issuer's data (issued-credential records, status lists, Keycloak) persists across deployments; the
  nightly reset does not touch it.
