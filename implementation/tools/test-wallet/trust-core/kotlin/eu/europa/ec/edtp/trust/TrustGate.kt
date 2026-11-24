/*
 * EDTP Test Wallet — granular trust verification (core): the gate.
 *
 * Every check site routes its result through [gate]. One place decides, from the active per-layer
 * mode, whether to (a) do nothing (OFF), (b) record only (OBSERVE), or (c) record and block
 * (ENFORCE + blocking outcome). Keeping it in one function is what makes "default = upstream" and the
 * observe/enforce distinction auditable from a single read.
 */
package eu.europa.ec.edtp.trust

object TrustGate {

    /**
     * Record [result] according to the active mode of its layer and, under ENFORCE, throw on a
     * blocking (FAIL/UNKNOWN) result so the caller can translate it into the point-appropriate
     * refusal. Returns the (possibly OFF-skipped) result for convenient chaining.
     *
     * - OFF     → nothing recorded, never throws (upstream behaviour).
     * - OBSERVE → recorded to the ledger, never throws.
     * - ENFORCE → recorded; throws [TrustBlockedException] iff the outcome is blocking.
     */
    fun gate(result: TrustCheckResult): TrustCheckResult {
        when (TrustConfigHolder.current().modeFor(result.layer)) {
            TrustMode.OFF -> return result
            TrustMode.OBSERVE -> TrustLedger.record(result)
            TrustMode.ENFORCE -> {
                TrustLedger.record(result)
                if (result.isBlocking) throw TrustBlockedException(result)
            }
        }
        return result
    }

    /**
     * Convenience for a site that computes a boolean. [onFail]/[onPass] let the caller pick the
     * reason code; detail is free text (cert subject, failing URL — never credential content).
     */
    inline fun check(
        layer: TrustLayer,
        point: TrustPoint,
        subject: TrustSubject,
        passed: Boolean,
        detail: String? = null,
        onPass: TrustReason = TrustReason.OK,
        onFail: TrustReason = TrustReason.OTHER,
    ): TrustCheckResult = gate(
        TrustCheckResult(
            layer = layer,
            point = point,
            subject = subject,
            outcome = if (passed) TrustOutcome.PASS else TrustOutcome.FAIL,
            reason = if (passed) onPass else onFail,
            detail = detail,
        )
    )

    /** Record an explicit UNKNOWN (e.g. a revocation source that could not be reached). Blocking
     *  under ENFORCE, as "cannot determine" must not be more permissive than "known good". */
    fun unknown(
        layer: TrustLayer,
        point: TrustPoint,
        subject: TrustSubject,
        reason: TrustReason = TrustReason.REVOCATION_STATUS_UNKNOWN,
        detail: String? = null,
    ): TrustCheckResult = gate(
        TrustCheckResult(layer, point, subject, TrustOutcome.UNKNOWN, reason, detail)
    )
}
