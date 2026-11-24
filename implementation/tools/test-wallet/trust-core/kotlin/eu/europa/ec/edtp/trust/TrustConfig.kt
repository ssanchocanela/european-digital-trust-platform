/*
 * EDTP Test Wallet — granular trust verification (core): configuration.
 *
 * The three layers are configured independently and tri-state. The compiled-in default is OFF for
 * every layer, so a build with no trust deviation behaves exactly as upstream. A build that compiles
 * in WD-21/22/23 seeds the modes from BuildConfig (stamped by build.sh), and a runtime Settings
 * toggle may override them per layer for a session.
 */
package eu.europa.ec.edtp.trust

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The active mode of each layer. Default: everything OFF (upstream behaviour). */
data class TrustConfig(
    val modes: Map<TrustLayer, TrustMode> = TrustLayer.entries.associateWith { TrustMode.OFF },
) {
    fun modeFor(layer: TrustLayer): TrustMode = modes[layer] ?: TrustMode.OFF

    val anyActive: Boolean get() = modes.values.any { it != TrustMode.OFF }

    companion object {
        val OFF = TrustConfig()

        /**
         * Parse a stamped spec such as "c1=observe,c2=observe,c3=enforce". Unknown tokens and unknown
         * modes are ignored (fall back to OFF) rather than throwing — build.sh is what refuses an
         * unbuildable flag; at runtime an unreadable value must never be more permissive than OFF.
         */
        fun parse(spec: String?): TrustConfig {
            if (spec.isNullOrBlank()) return OFF
            val modes = HashMap<TrustLayer, TrustMode>()
            for (part in spec.split(',')) {
                val kv = part.trim().lowercase().split('=')
                if (kv.size != 2) continue
                val layer = when (kv[0]) {
                    "c1", "c1_signatures", "signatures" -> TrustLayer.C1_SIGNATURES
                    "c2", "c2_chain", "chain" -> TrustLayer.C2_CHAIN
                    "c3", "c3_revocation", "revocation" -> TrustLayer.C3_REVOCATION
                    else -> continue
                }
                val mode = when (kv[1]) {
                    "observe" -> TrustMode.OBSERVE
                    "enforce" -> TrustMode.ENFORCE
                    "off" -> TrustMode.OFF
                    else -> continue
                }
                modes[layer] = mode
            }
            return TrustConfig(TrustLayer.entries.associateWith { modes[it] ?: TrustMode.OFF })
        }
    }
}

/**
 * Process-wide holder of the active [TrustConfig]. Seeded once at app start from the build stamp
 * (see README: EDTP_TRUST spec), then optionally overridden by the Settings screen.
 *
 * Kept as a tiny observable singleton rather than injected, because the deepest check seams that read
 * it (steps C1–C3, inside wallet-core/etsi patches) have no DI graph to reach the app's container.
 */
object TrustConfigHolder {
    private val _config = MutableStateFlow(TrustConfig.OFF)
    val config: StateFlow<TrustConfig> = _config.asStateFlow()

    /** Seed from the build stamp. Called once, early. Idempotent. */
    fun seed(spec: String?) {
        _config.value = TrustConfig.parse(spec)
    }

    /** Runtime override of one layer (Settings). */
    fun setMode(layer: TrustLayer, mode: TrustMode) {
        val current = _config.value.modes.toMutableMap()
        current[layer] = mode
        _config.value = TrustConfig(current)
    }

    fun current(): TrustConfig = _config.value
}
