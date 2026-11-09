package com.pulse.ingest

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #528 — the importer must NOT re-ingest records Pulse itself wrote to Health Connect. Without this,
 * turning on "share back" and then importing would re-read Pulse's own daily totals and sum them on
 * top of the original source records (cumulative steps / active energy / sleep would ~double). Pins
 * the pure package-match decision used at [HealthConnectImporter] readAll's choke point.
 */
class HealthConnectSelfWriteSkipTest {

    private val self = "com.pulse.whoop"

    @Test fun skipsRecordsPulseWroteItself() {
        assertTrue(HealthConnectImporter.isSelfWritten(self, self))
    }

    @Test fun keepsRecordsFromOtherSources() {
        assertFalse(HealthConnectImporter.isSelfWritten("com.google.android.apps.fitness", self))
        assertFalse(HealthConnectImporter.isSelfWritten("com.sec.android.app.shealth", self))
        assertFalse(HealthConnectImporter.isSelfWritten("com.pulse.whoop.demo", self)) // different pkg
    }

    @Test fun keepsWhenOriginUnknownOrSelfBlank() {
        // Err toward keeping data: if we can't determine self, skip nothing.
        assertFalse(HealthConnectImporter.isSelfWritten("", self))
        assertFalse(HealthConnectImporter.isSelfWritten(self, ""))
    }
}
