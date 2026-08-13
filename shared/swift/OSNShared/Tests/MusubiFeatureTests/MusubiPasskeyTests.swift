import Foundation
import OSNAuth
import Testing
@testable import MusubiFeature

private let nowSeconds = 1_700_000_000

/// `PasskeySummary` has no public memberwise init — it is a wire type, so
/// the tests build it the way the app does, off JSON. That the decode is
/// exercised too is a bonus, not the point.
private func makeSummary(_ json: String) throws -> PasskeySummary {
    try JSONDecoder().decode(PasskeySummary.self, from: Data(json.utf8))
}

@Suite struct MusubiPasskeyTests {
    @Test func decodesUnixSecondsAsSeconds() throws {
        let summary = try makeSummary(
            """
            {
              "id": "pk_1",
              "label": "iPhone",
              "createdAt": \(nowSeconds),
              "lastUsedAt": \(nowSeconds + 60),
              "backupEligible": true,
              "backupState": true
            }
            """
        )

        let passkey = MusubiPasskey(summary)

        #expect(passkey.createdAt == Date(timeIntervalSince1970: TimeInterval(nowSeconds)))
        #expect(passkey.lastUsedAt == Date(timeIntervalSince1970: TimeInterval(nowSeconds + 60)))
        #expect(passkey.displayLabel == "iPhone")
        #expect(passkey.isSynced)
        #expect(!passkey.isDeviceBound)
    }

    /// Absent backup flags read as false. Saying "synced" when the
    /// authenticator never claimed it is the one answer that could cost
    /// someone their account.
    @Test func missingBackupFlagsAreNotSynced() throws {
        let summary = try makeSummary(
            """
            { "id": "pk_1", "createdAt": \(nowSeconds) }
            """
        )

        let passkey = MusubiPasskey(summary)

        #expect(!passkey.isSynced)
        #expect(!passkey.isDeviceBound)
        #expect(passkey.displayLabel == "Unnamed passkey")
    }

    /// Eligible but not backed up: the state the row warns about.
    @Test func eligibleButUnbackedIsDeviceBound() throws {
        let summary = try makeSummary(
            """
            { "id": "pk_1", "createdAt": \(nowSeconds), "backupEligible": true, "backupState": false }
            """
        )

        #expect(MusubiPasskey(summary).isDeviceBound)
    }

    /// Never used again → last active is when it was added, so a fresh
    /// passkey doesn't sink to the bottom of the list.
    @Test func lastActiveFallsBackToCreatedAt() throws {
        let summary = try makeSummary(
            """
            { "id": "pk_1", "createdAt": \(nowSeconds) }
            """
        )

        #expect(MusubiPasskey(summary).lastActive == Date(timeIntervalSince1970: TimeInterval(nowSeconds)))
    }

    @Test func sortsMostRecentlyUsedFirst() {
        let old = MusubiPasskey(
            id: "old",
            label: nil,
            createdAt: Date(timeIntervalSince1970: 0),
            lastUsedAt: Date(timeIntervalSince1970: 100),
            backupEligible: false,
            backupState: false
        )
        let recent = MusubiPasskey(
            id: "recent",
            label: nil,
            createdAt: Date(timeIntervalSince1970: 0),
            lastUsedAt: Date(timeIntervalSince1970: 500),
            backupEligible: false,
            backupState: false
        )

        #expect([old, recent].sortedForDisplay().map(\.id) == ["recent", "old"])
    }
}
