/*
 * EDTP Test Wallet — granular trust verification (core).
 *
 * This is EDTP-added code (not upstream EUDI Reference Wallet). It is inert unless at least one
 * trust layer is set to OBSERVE or ENFORCE; with every layer OFF the wallet behaves exactly as
 * upstream. See tools/test-wallet/TRUST-GRANULAR-design.md and the WD-21/22/23 register entries.
 *
 * Package deliberately distinct (eu.europa.ec.edtp.*) so nothing here can be mistaken for upstream
 * wallet-core or reference-app code.
 */
package eu.europa.ec.edtp.trust

/** The three independent validation layers the wallet can run. */
enum class TrustLayer { C1_SIGNATURES, C2_CHAIN, C3_REVOCATION }

/** Per-layer mode. OFF = do not run (upstream behaviour); OBSERVE = run + record, never block;
 *  ENFORCE = run + record, and block the flow on a failed/unknown result. */
enum class TrustMode { OFF, OBSERVE, ENFORCE }

/** Where in the lifecycle a check ran. */
enum class TrustPoint { OFFER, PRESTORE, PRESENT }

/** What the check was about. Kept coarse on purpose — the detail string carries specifics. */
enum class TrustSubject {
    ISSUER_SIGNATURE,       // mdoc MSO / SD-JWT VC issuer signature
    DOC_SIGNER_CHAIN,       // issuer document-signer certificate chain vs LoTE anchors
    CREDENTIAL_STATUS,      // the issued credential's own status list
    REQUEST_OBJECT_SIG,     // OpenID4VP request object signature / ISO reader auth
    RPAC,                   // relying-party / reader access certificate (chain, validity, revocation)
    RPRC,                   // relying-party / issuer registration certificate (WRPRC)
    HOLDER_BINDING,         // cnf / device-key binding, isBoundTo(access cert)
    ENTITLEMENT,            // issuer entitlements / over-provisioning / over-asking
}

/** Outcome of a single check. UNKNOWN is a first-class failure mode (e.g. revocation not reachable). */
enum class TrustOutcome { PASS, FAIL, UNKNOWN, SKIP }

/**
 * Reason codes. These mirror the enums the upstream core already produces so the overlay can show
 * the same vocabulary a developer would see in logs. Not exhaustive; [TrustCheckResult.detail]
 * carries anything finer. OTHER is the catch-all.
 */
enum class TrustReason {
    OK,
    SIGNATURE_INVALID,
    UNTRUSTED_PROVIDER,
    NOT_BOUND_TO_REQUESTER,
    EXPIRED,
    REVOKED,
    REVOCATION_STATUS_UNKNOWN,
    STATUS_MISSING,
    ENTITLEMENT_MISSING,
    OVER_ASKING,
    MALFORMED,
    NOT_EVALUATED,
    OTHER,
}

/** One recorded check. Immutable; the ledger only ever appends. */
data class TrustCheckResult(
    val layer: TrustLayer,
    val point: TrustPoint,
    val subject: TrustSubject,
    val outcome: TrustOutcome,
    val reason: TrustReason = if (outcome == TrustOutcome.PASS) TrustReason.OK else TrustReason.OTHER,
    val detail: String? = null,
    val atMillis: Long = System.currentTimeMillis(),
) {
    val isBlocking: Boolean get() = outcome == TrustOutcome.FAIL || outcome == TrustOutcome.UNKNOWN
}

/** Thrown by [TrustGate] when a layer in ENFORCE sees a blocking result. Callers translate it into
 *  the point-appropriate refusal (OfferResult.Failure / delete-then-fail / deny-before-consent). */
class TrustBlockedException(
    val result: TrustCheckResult,
) : Exception("EDTP trust ${result.layer} ENFORCE blocked: ${result.subject}=${result.reason}")
