/*
 * EDTP Test Wallet — granular trust verification (core): floating overlay (skeleton).
 *
 * A dismissible, expandable panel that shows what the trust layers checked in the current flow and
 * what failed. It renders ONLY when this is an EDTP build AND at least one layer is active — so a
 * build with trust OFF shows nothing, preserving "default = upstream".
 *
 * Skeleton: Material3 primitives only, no app-theme coupling. The host wires it once, above the nav
 * host, and passes whether this is an EDTP build (BuildConfig.EDTP_BUILD). Visual polish, drag,
 * per-row detail sheet and i18n strings come after the core is reviewed.
 */
package eu.europa.ec.edtp.trust.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import eu.europa.ec.edtp.trust.LayerTally
import eu.europa.ec.edtp.trust.TrustCheckResult
import eu.europa.ec.edtp.trust.TrustConfigHolder
import eu.europa.ec.edtp.trust.TrustLayer
import eu.europa.ec.edtp.trust.TrustLedger
import eu.europa.ec.edtp.trust.TrustOutcome
import kotlinx.coroutines.flow.combine

/**
 * Drop this once near the root of the Composable tree, above the app content.
 *
 * @param isEdtpBuild pass BuildConfig.EDTP_BUILD. When false the overlay never composes anything.
 */
@Composable
fun TrustOverlay(isEdtpBuild: Boolean) {
    if (!isEdtpBuild) return

    val state by remember {
        TrustConfigHolder.config.combine(TrustLedger.current) { cfg, run ->
            OverlayState(active = cfg.anyActive, run = run)
        }
    }.collectAsStateSafe(initial = OverlayState(active = false, run = null))

    if (!state.active) return
    val run = state.run ?: return

    var expanded by remember { mutableStateOf(false) }
    val tallies = run.countsByLayer()

    Card(modifier = Modifier.fillMaxWidth().padding(8.dp)) {
        // Collapsed: one badge per layer with pass/fail/unknown counts.
        Row(modifier = Modifier.fillMaxWidth().padding(8.dp)) {
            TrustLayer.entries.forEach { layer ->
                LayerBadge(layer, tallies[layer], onClick = { expanded = !expanded })
            }
        }
        if (expanded) {
            LazyColumn(modifier = Modifier.fillMaxWidth().padding(8.dp)) {
                items(run.results) { r -> TrustRow(r) }
            }
        }
    }
}

@Composable
private fun LayerBadge(layer: TrustLayer, tally: LayerTally?, onClick: () -> Unit) {
    val label = buildString {
        append(
            when (layer) {
                TrustLayer.C1_SIGNATURES -> "C1"
                TrustLayer.C2_CHAIN -> "C2"
                TrustLayer.C3_REVOCATION -> "C3"
            }
        )
        if (tally != null && tally.anyRecorded) {
            append(' ')
            append(if (tally.anyBlocking) "✗${tally.fail + tally.unknown}" else "✓")
        }
    }
    AssistChip(onClick = onClick, label = { Text(label) }, modifier = Modifier.padding(end = 6.dp))
}

@Composable
private fun TrustRow(r: TrustCheckResult) {
    val mark = when (r.outcome) {
        TrustOutcome.PASS -> "✓"
        TrustOutcome.FAIL, TrustOutcome.UNKNOWN -> "✗"
        TrustOutcome.SKIP -> "–"
    }
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Text("$mark  ${r.subject}  —  ${r.reason}")
        r.detail?.let { Text("     $it") }
    }
}

private data class OverlayState(val active: Boolean, val run: eu.europa.ec.edtp.trust.TrustRun?)

/*
 * collectAsStateSafe: a thin stand-in so this file stays decoupled from the exact
 * androidx.lifecycle.compose version the app ships. The host should replace it with
 * collectAsStateWithLifecycle(). Declared here only to keep the skeleton self-contained for review.
 */
@Composable
private fun <T> kotlinx.coroutines.flow.Flow<T>.collectAsStateSafe(initial: T) =
    androidx.compose.runtime.produceState(initialValue = initial, this) {
        collect { value = it }
    }
