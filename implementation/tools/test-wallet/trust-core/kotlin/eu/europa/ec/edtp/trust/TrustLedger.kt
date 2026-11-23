/*
 * EDTP Test Wallet — granular trust verification (core): the ledger.
 *
 * A process-wide, observable record of the checks run in the current flow (and the one before, kept
 * for review). The floating overlay subscribes to [current]; check sites append through [record]
 * (usually via TrustGate). Nothing here persists to disk — it is transient UI/diagnostic state and
 * holds no credential content, only subjects, outcomes, reason codes and short detail strings.
 */
package eu.europa.ec.edtp.trust

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** A single lifecycle flow and the checks recorded against it. */
data class TrustRun(
    val point: TrustPoint,
    val correlationId: String,
    val startedAtMillis: Long = System.currentTimeMillis(),
    val results: List<TrustCheckResult> = emptyList(),
    val finished: Boolean = false,
) {
    fun countsByLayer(): Map<TrustLayer, LayerTally> =
        TrustLayer.entries.associateWith { layer ->
            val forLayer = results.filter { it.layer == layer }
            LayerTally(
                pass = forLayer.count { it.outcome == TrustOutcome.PASS },
                fail = forLayer.count { it.outcome == TrustOutcome.FAIL },
                unknown = forLayer.count { it.outcome == TrustOutcome.UNKNOWN },
                skip = forLayer.count { it.outcome == TrustOutcome.SKIP },
            )
        }

    val hasBlocking: Boolean get() = results.any { it.isBlocking }
}

data class LayerTally(val pass: Int, val fail: Int, val unknown: Int, val skip: Int) {
    val anyRecorded: Boolean get() = pass + fail + unknown + skip > 0
    val anyBlocking: Boolean get() = fail + unknown > 0
}

object TrustLedger {

    private val _current = MutableStateFlow<TrustRun?>(null)
    /** The live flow (or null before the first). The overlay observes this. */
    val current: StateFlow<TrustRun?> = _current.asStateFlow()

    private val _previous = MutableStateFlow<TrustRun?>(null)
    /** The flow before the current one, retained so a failed run can still be inspected. */
    val previous: StateFlow<TrustRun?> = _previous.asStateFlow()

    /** Begin a new flow. The outgoing current (if any) is moved to [previous]. No-op-safe to call
     *  when trust is OFF — callers should skip it then, but a stray call just starts an empty run. */
    @Synchronized
    fun startRun(point: TrustPoint, correlationId: String) {
        _current.value?.let { _previous.value = it.copy(finished = true) }
        _current.value = TrustRun(point = point, correlationId = correlationId)
    }

    /** Append a check result to the current flow. Starts an implicit flow if none is open, so a
     *  check that fires outside an explicit run is still visible rather than lost. */
    @Synchronized
    fun record(result: TrustCheckResult) {
        val run = _current.value ?: TrustRun(point = result.point, correlationId = "implicit")
        _current.value = run.copy(results = run.results + result)
    }

    @Synchronized
    fun finishRun() {
        _current.value = _current.value?.copy(finished = true)
    }

    /** Clear everything (e.g. when trust is turned OFF at runtime). */
    @Synchronized
    fun reset() {
        _current.value = null
        _previous.value = null
    }
}
