import Foundation
import Testing
@testable import MusubiFeature
@testable import OSNAPI

private typealias SessionPayload = Operations.ListSessions.Output.Ok.Body.JsonPayload.SessionsPayloadPayload

/// 2023-11-14 22:13:20 UTC, as Unix seconds — the unit the route documents
/// (`sessionSummary` in `osn/api/src/routes/auth/response-schemas.ts`).
private let nowSeconds: Double = 1_700_000_000

private func makeSessionPayload(
    id: String,
    createdAt: Double = nowSeconds,
    lastUsedAt: Double? = nil,
    expiresAt: Double = nowSeconds + 2_592_000,
    isCurrent: Bool = false,
    uaLabel: String? = "iPhone · Safari"
) -> SessionPayload {
    .init(
        createdAt: createdAt,
        expiresAt: expiresAt,
        id: id,
        isCurrent: isCurrent,
        lastUsedAt: lastUsedAt,
        uaLabel: uaLabel
    )
}

@Suite struct MusubiDeviceTests {
    @Test func readsWireSecondsAsDates() {
        let device = MusubiDevice(
            makeSessionPayload(id: "s1", createdAt: nowSeconds, lastUsedAt: nowSeconds + 60)
        )

        #expect(device.id == "s1")
        #expect(device.createdAt == Date(timeIntervalSince1970: nowSeconds))
        #expect(device.lastUsedAt == Date(timeIntervalSince1970: nowSeconds + 60))
        #expect(device.expiresAt == Date(timeIntervalSince1970: nowSeconds + 2_592_000))
    }

    /// A session used exactly once has no `lastUsedAt`, and its creation is
    /// the last thing that happened on it.
    @Test func unusedSessionFallsBackToItsCreation() {
        let device = MusubiDevice(makeSessionPayload(id: "s1", lastUsedAt: nil))

        #expect(device.lastUsedAt == nil)
        #expect(device.lastActive == Date(timeIntervalSince1970: nowSeconds))
    }

    /// An unlabelled session is the one most worth revoking, so it gets a
    /// name rather than an empty row.
    @Test func unlabelledSessionStillHasSomethingToShow() {
        #expect(MusubiDevice(makeSessionPayload(id: "s1", uaLabel: nil)).displayLabel == "Unknown device")
        #expect(MusubiDevice(makeSessionPayload(id: "s2", uaLabel: "Mac · Safari")).displayLabel == "Mac · Safari")
    }

    @Test func currentDeviceSortsFirstEvenWhenLeastRecentlyActive() {
        let devices = [
            MusubiDevice(makeSessionPayload(id: "recent", lastUsedAt: nowSeconds + 500)),
            MusubiDevice(makeSessionPayload(id: "mine", lastUsedAt: nowSeconds, isCurrent: true)),
            MusubiDevice(makeSessionPayload(id: "older", lastUsedAt: nowSeconds + 100)),
        ]

        #expect(devices.sortedForDisplay().map(\.id) == ["mine", "recent", "older"])
    }

    /// Sorting compares `lastActive`, not `lastUsedAt`, so a never-reused
    /// session lands by its creation instead of at one end of the list.
    @Test func neverReusedSessionSortsByCreation() {
        let devices = [
            MusubiDevice(makeSessionPayload(id: "used", lastUsedAt: nowSeconds + 10)),
            MusubiDevice(makeSessionPayload(id: "fresh", createdAt: nowSeconds + 900, lastUsedAt: nil)),
        ]

        #expect(devices.sortedForDisplay().map(\.id) == ["fresh", "used"])
    }
}
