# EDTP trust core (step 1)

Infrastructure for the granular trust checks (C1 signatures / C2 chain / C3 revocation) described in
[`../TRUST-GRANULAR-design.md`](../TRUST-GRANULAR-design.md). These are the pieces that are **layer-
and point-agnostic**; the per-layer wiring (steps C1–C3) lands later as its own deviations.

**Status: wired into the build (step 2 done); compile UNVERIFIED.** The canonical source now lives in
`patches/0004-edtp-trust-core.patch` (installed into `business-logic`/`ui-logic` of the clone, with
the `ContentScreen` mount, `Application` seed, `AppFlavor`/banner `EDTP_TRUST` field) plus the
`--trust` flag in `build.sh` and the WD-21/22/23 entries in `deviations.md`. These Kotlin files are
the readable copy of what 0004 adds. Not yet compiled: a wallet build (`build.sh`) and the Android
toolchain are needed to confirm it builds — per the repo's "do not fake integration" rule, that
remains to be run. `patches/0004` passed `git apply --reverse --check` (consistent, applies after
0001–0003); `--trust off|observe` is accepted, `--trust …=enforce` is refused until C1–C3 land.

## Files (package `eu.europa.ec.edtp.trust`)

| File | What |
|---|---|
| `TrustModel.kt` | enums (`TrustLayer`, `TrustMode`, `TrustPoint`, `TrustSubject`, `TrustOutcome`, `TrustReason`), `TrustCheckResult`, `TrustBlockedException` |
| `TrustConfig.kt` | `TrustConfig` (mode per layer, default OFF), `TrustConfigHolder` (observable singleton, seed from build stamp + runtime override) |
| `TrustLedger.kt` | observable per-flow record (`current`/`previous` `StateFlow`); no disk, no credential content |
| `TrustGate.kt` | the single `gate()` every check routes through: OFF=skip, OBSERVE=record, ENFORCE=record+throw on blocking |
| `ui/TrustOverlay.kt` | Compose overlay skeleton; renders only when `EDTP_BUILD && anyActive` |

## Inertness (default = upstream)

With every layer OFF: `gate()` records nothing and never throws; the overlay composes nothing;
`TrustLedger` stays empty. A build with no trust deviation is byte-for-byte upstream behaviour.

## How it will be wired (step 1 remainder, next micro-steps)

1. **Install sources** into the generated `edtptest` source set via a new base patch
   `patches/0004-edtp-trust-core.patch` (new files only — no upstream file is modified by the core).
2. **Config stamp.** Extend the `addConfigField(...)` block in
   `patches/0001-edtptest-flavour-identity-and-deviation-flags.patch` with
   `EDTP_TRUST` (a spec string like `c1=observe,c2=observe,c3=enforce`), stamped into
   `version.properties` by `build.sh` from a new `--trust` flag. Seed once at app start:
   `TrustConfigHolder.seed(BuildConfig.EDTP_TRUST)`.
3. **Banner.** Add the active trust spec to the modified-build banner
   (`patches/0003-modified-build-banner.patch`) and to the run record, so a screenshot/log is never
   ambiguous about which layers were enforcing.
4. **Overlay mount.** `TrustOverlay(isEdtpBuild = BuildConfig.EDTP_BUILD)` once above the nav host.
5. **Settings toggle** (optional, later): three tri-state pickers calling `TrustConfigHolder.setMode`.

The per-layer check sites (C1/C2/C3) then call `TrustGate.gate(...)` / `TrustGate.check(...)`. Those
that are app-observable (offer `issuerRegistration`, `TransferEvent.RequestReceived`) are app-side
patches; the deep ones require wallet-core / etsi rebuilds in the WD-14 / WD-10 manner. Built so far:
the verifier **fail-open** is closed (`deviations/edtp-c1-failclosed.patch` + `patches/0009`, armed by
reflection from the app) and `relaxPkixRevocation` is gated on C3 == `ENFORCE` (build.sh WD-14 step).
Still pending: RPAC revocation on the ETSI path, the credential's own status list pre-store.

## build.sh refusal rule

Per `CLAUDE.md` §6.22, `build.sh` refuses a deviation flag it cannot honestly honour. `--trust` must
therefore refuse a layer set to `enforce` whose wiring is not compiled in yet — i.e. each of
WD-21/22/23 gates the `enforce`/`observe` acceptance for its own layer.
