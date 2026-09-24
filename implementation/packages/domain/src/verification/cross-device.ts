import { PlatformError } from "@edtp/shared";
import type { RetentionPolicy } from "../kernel/policies.js";
import type { AccessCertificate } from "../kernel/registration.js";

/**
 * Cross-device mitigations for a redirect-based (custom-URI) presentation flow.
 *
 * ## Why this module exists
 *
 * `EW-PIO-01-016` (`OIA_08c`) says Wallet Units SHOULD NOT support a redirects-based
 * transmission mechanism for cross-device presentation flows, and `EW-PIO-01-017` (`OIA_08d`)
 * obliges a Relying Party that uses one anyway to "implement adequate mitigations for the
 * challenges described in Section 4.4.3.1 of the ARF main document".
 *
 * **That citation is wrong.** In ARF 3.0.0 §4.4.3.1 is "Introduction"; the challenges are in
 * **§4.4.3.2, "Challenges for remote presentation flows using custom URIs"**. Recorded as a
 * baseline inconsistency in `docs/interop-findings.md` D6 and noted in `docs/traceability.md`.
 *
 * ## The five challenges, and who can actually address each
 *
 * ARF §4.4.3.2 lists five. ARF's own answer to all five is to use the W3C Digital Credentials
 * API instead, which is out of scope for V0. So for each, the question is what a **Relying
 * Party** can do with custom URIs:
 *
 * | # | Challenge (ARF §4.4.3.2) | Can an RP mitigate it? |
 * |---|---|---|
 * | 1 | **Secure cross-device flows** — phishing and relay attacks; ARF says OS-managed proximity checks mitigate them | **Partly.** The proximity check needs the DC API and CTAP, which only the OS and browser can provide. An RP can shrink the window the attack has — mitigation `QR_SHORT_LIFETIME` |
 * | 2 | **Wallet Unit selection** — the user may pick the wrong Wallet Unit | **No.** This needs the unified browser/OS interface. Residual |
 * | 3 | **Invocation mechanism** — inconsistent custom-URI invocation across browsers and OSes | **No.** Residual |
 * | 4 | **Clear origin verification** — the Wallet needs the Relying Party Instance's origin to resist relay attacks | **Partly.** A redirect flow has no browser-supplied origin. What an RP can guarantee instead is that the request is cryptographically attributable for its whole lifetime — mitigation `QR_REQUESTER_AUTHENTICATED` |
 * | 5 | **Session binding** — context switching can enable session hijacking | **Yes.** Nothing is returned through the interaction channel, and the result is readable only by the authenticated tenant — mitigation `QR_NO_RESULT_VIA_INTERACTION_CHANNEL` |
 *
 * Two of five are addressable, one partly, two not at all. So `OIA_08d` is **not** satisfied,
 * and this module does not claim otherwise: see `docs/security-limitations.md` P1 for the
 * residual risk and ADR 0009 for the reasoning.
 */

/** Stable identifiers, so the audit trail and the documentation cannot drift apart. */
export const CROSS_DEVICE_MITIGATIONS = [
  /**
   * Challenge 1. A redirect-based cross-device flow cannot have the OS proximity check, so the
   * window in which a phished or relayed request is still usable is capped well below the
   * same-device default. The engine additionally enforces single use, so a captured URI is
   * worthless once consumed — this bounds the time before that happens.
   */
  "QR_SHORT_LIFETIME",
  /**
   * Challenge 4. With no browser-supplied origin, the only thing that lets a Wallet attribute
   * the request is the signed request object and its access certificate. The platform therefore
   * refuses a QR transaction whose access certificate would expire inside the transaction
   * lifetime, so the request is attributable for as long as it is live.
   */
  "QR_REQUESTER_AUTHENTICATED",
  /**
   * Challenge 5. The cross-device interaction URI carries no completion redirect, so nothing is
   * returned to whichever device followed it. The settled result is readable only through the
   * authenticated business API, which binds the result to the tenant that created the
   * transaction rather than to whoever scanned the code.
   */
  "QR_NO_RESULT_VIA_INTERACTION_CHANNEL",
  /**
   * Not a challenge from §4.4.3.2, but a precondition for the others being meaningful: the
   * discouraged flow is never the default. It must be requested per transaction and its use is
   * audited, so it cannot be adopted silently.
   */
  "QR_EXPLICIT_OPT_IN_AUDITED",
] as const;

export type CrossDeviceMitigation = (typeof CROSS_DEVICE_MITIGATIONS)[number];

/**
 * Challenges from ARF §4.4.3.2 that remain unmitigated in a custom-URI cross-device flow.
 *
 * Carried in the audit record so the residual risk is visible per transaction, not only in a
 * document somebody may not read.
 */
export const CROSS_DEVICE_RESIDUAL_RISKS = [
  /** Challenge 1, the part an RP cannot reach: no OS-managed proximity check. */
  "NO_PROXIMITY_CHECK",
  /** Challenge 2. */
  "NO_UNIFIED_WALLET_SELECTION",
  /** Challenge 3. */
  "INCONSISTENT_INVOCATION",
  /** Challenge 4, the part an RP cannot reach: no browser-supplied origin. */
  "NO_BROWSER_SUPPLIED_ORIGIN",
] as const;

export type CrossDeviceResidualRisk = (typeof CROSS_DEVICE_RESIDUAL_RISKS)[number];

/**
 * Maximum transaction lifetime for a cross-device QR flow.
 *
 * Deliberately well below `DEFAULT_TRANSACTION_LIFETIME_SECONDS`. There is no specified value to
 * cite — ARF names the challenge, not a number — so this is a platform choice, recorded as such
 * in ADR 0009: long enough for a person to pick up a phone, scan and approve, short enough that
 * a captured URI is stale quickly.
 */
export const QR_MAX_TRANSACTION_LIFETIME_SECONDS = 120;

export interface CrossDeviceDecision {
  /** The lifetime to use, after capping. */
  readonly transactionLifetimeSeconds: number;
  /** Mitigations actually applied, for the audit record. */
  readonly mitigationsApplied: readonly CrossDeviceMitigation[];
  /** Challenges that remain unaddressed, for the audit record. */
  readonly residualRisks: readonly CrossDeviceResidualRisk[];
  /** True when the policy's configured lifetime was shortened. */
  readonly lifetimeCapped: boolean;
}

export interface CrossDeviceInput {
  readonly retentionPolicy: RetentionPolicy;
  readonly accessCertificate: AccessCertificate;
  readonly at: Date;
}

/**
 * Applies the cross-device mitigations and returns the effective parameters.
 *
 * Throws when `QR_REQUESTER_AUTHENTICATED` cannot be guaranteed. Refusing is the right outcome:
 * the alternative is a live request that the Wallet may be unable to attribute for part of its
 * life, which is the relay-attack surface challenge 4 is about.
 */
export const applyCrossDeviceMitigations = (input: CrossDeviceInput): CrossDeviceDecision => {
  const { retentionPolicy, accessCertificate, at } = input;

  const configured = retentionPolicy.transactionLifetimeSeconds;
  const transactionLifetimeSeconds = Math.min(configured, QR_MAX_TRANSACTION_LIFETIME_SECONDS);
  const lifetimeCapped = transactionLifetimeSeconds < configured;

  const expiresAt = new Date(at.getTime() + transactionLifetimeSeconds * 1000);
  if (
    accessCertificate.notAfter &&
    accessCertificate.notAfter.getTime() < expiresAt.getTime()
  ) {
    throw PlatformError.conflict(
      "access_certificate_expires_during_transaction",
      "A cross-device (QR) presentation requires the access certificate to remain valid for the " +
        "whole transaction lifetime, because the signed request object is the only way a Wallet " +
        "can attribute the request in a flow that carries no browser-supplied origin.",
    );
  }

  return {
    transactionLifetimeSeconds,
    mitigationsApplied: CROSS_DEVICE_MITIGATIONS,
    residualRisks: CROSS_DEVICE_RESIDUAL_RISKS,
    lifetimeCapped,
  };
};
