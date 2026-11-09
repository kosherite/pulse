import GRDB
import XCTest
@testable import PulseLocalAccessCore

final class ReadonlyPulseStoreTests: XCTestCase {
    func testReadsSeededPulseStoreWithoutOpeningWritableHandle() throws {
        let url = try TemporaryDatabase.seeded()
        let store = try ReadonlyPulseStore(path: url.path)

        XCTAssertTrue(try store.isReadOnlyForTest())
        XCTAssertEqual(try store.latestHRSampleTs(deviceId: "my-whoop"), 102)
        XCTAssertEqual(try store.metricKeys(deviceId: "my-whoop"), ["hrv"])

        let daily = try store.dailyMetrics(deviceId: "my-whoop", from: "2026-06-01", to: "2026-06-30")
        XCTAssertEqual(daily.map(\.day), ["2026-06-10"])
        XCTAssertEqual(daily.first?.recovery, 67)

        let stats = try store.storageStats()
        XCTAssertEqual(stats.decodedRows, 4)
        XCTAssertEqual(stats.rawBatches, 1)
        XCTAssertEqual(stats.rawBytes, 12)
    }

    func testForeignPulseLikeDatabaseIsRejectedWithoutQuarantine() throws {
        let url = try TemporaryDatabase.foreignPulseLike()

        XCTAssertThrowsError(try ReadonlyPulseStore(path: url.path)) { error in
            guard case .databaseUnavailable(let message) = error as? LocalAccessError else {
                return XCTFail("Expected LocalAccessError.databaseUnavailable")
            }
            XCTAssertTrue(message.contains("without GRDB migration metadata"))
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    }
}
