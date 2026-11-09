package com.pulse.analytics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the banked-sleep heal's device SCOPE (#1248). The `#899` overlap heal used to read/dedupe/delete
 * only under `computedId`, so a live source that banks its OWN hypnogram under its OWN device id (an Oura
 * ring) was never healed — and those un-collapsed rows were re-read as `providedSleep` and re-detected
 * every pass, ballooning one night to 14 stored rows / 9 phantom "naps". `healDeviceIds` is the pure set
 * of ids the heal now sweeps; tested directly. Mirrors the Swift `IntelligenceHealDeviceScopeTests` so the
 * two platforms heal the same device ids.
 */
class IntelligenceHealDeviceScopeTest {

    @Test
    fun ringIdIsInScope_theBug() {
        // The exact #1248 shape: a WHOOP is primary (computed under "my-whoop-pulse") and an Oura ring
        // banks its own hypnogram under "oura-2H3B". The ring id MUST be swept.
        val ids = IntelligenceEngine.healDeviceIds("my-whoop-pulse", listOf("my-whoop", "oura-2H3B"))
        assertEquals(listOf("my-whoop", "my-whoop-pulse", "oura-2H3B"), ids)
        assertTrue("the ring id the computedId-only heal missed", ids.contains("oura-2H3B"))
    }

    @Test
    fun computedIdAlwaysPresent_evenWithNoRegisteredDevices() {
        // A BLE-only install with an empty registry still heals its computed rows (the prior behaviour).
        assertEquals(listOf("my-whoop-pulse"), IntelligenceEngine.healDeviceIds("my-whoop-pulse", emptyList()))
    }

    @Test
    fun deDuplicatesAndSortsDeterministically() {
        // computedId can also appear in the registry list; the union de-dups and sorts so the sweep order
        // is stable across runs and matches Swift's Set(...).sorted().
        val ids = IntelligenceEngine.healDeviceIds("b-pulse", listOf("oura-1", "b-pulse", "a-whoop"))
        assertEquals(listOf("a-whoop", "b-pulse", "oura-1"), ids)
    }
}
