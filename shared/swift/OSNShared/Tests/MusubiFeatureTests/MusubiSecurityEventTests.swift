import Foundation
import Testing
@testable import MusubiFeature

@Suite struct SecurityEventKindTests {
    @Test func everyKnownKindRoundTripsThroughTheWire() {
        let kinds: [SecurityEventKind] = [
            .recoveryCodeGenerate, .recoveryCodeConsume, .recoveryCodeLockout,
            .passkeyRegister, .passkeyDelete, .crossDeviceLogin,
            .accountDeletionScheduled, .accountDeletionCancelled, .accountDeletionCompleted,
            .appDeletionScheduled, .appDeletionCancelled, .appDeletionCompleted,
        ]

        for kind in kinds {
            #expect(SecurityEventKind(wire: kind.wire) == kind)
        }
    }

    /// A kind the server grew after this build shipped. Dropping it would
    /// hide the one thing the screen exists to show, so it survives as
    /// `other` and round-trips unchanged.
    @Test func anUnknownKindIsKeptRatherThanDropped() {
        let kind = SecurityEventKind(wire: "password_reset_requested")

        #expect(kind == .other("password_reset_requested"))
        #expect(kind.wire == "password_reset_requested")
        #expect(kind.title == "Password reset requested")
        #expect(!kind.systemImage.isEmpty)
    }

    @Test func everyKnownKindHasATitleAndAnIcon() {
        for wire in ["recovery_code_consume", "passkey_delete", "cross_device_login", "app_deletion_completed"] {
            let kind = SecurityEventKind(wire: wire)
            #expect(!kind.title.isEmpty)
            #expect(!kind.systemImage.isEmpty)
        }
    }
}

@Suite struct MusubiSecurityEventTests {
    private func event(id: String, createdAt: TimeInterval, ipHash: String? = nil, label: String? = nil) -> MusubiSecurityEvent {
        MusubiSecurityEvent(
            id: id,
            kind: .passkeyRegister,
            createdAt: Date(timeIntervalSince1970: createdAt),
            deviceLabel: label,
            ipHash: ipHash
        )
    }

    @Test func displayLocationIsAShortPrefixOfTheHash() {
        let hashed = event(id: "sev_1", createdAt: 0, ipHash: "0123456789abcdef0123456789abcdef")

        #expect(hashed.displayLocation == "01234567")
    }

    /// No user-agent on the request means no label and no hash. Neither is
    /// an error, and neither should render as an empty line.
    @Test func missingDeviceAndLocationDegradeQuietly() {
        let bare = event(id: "sev_1", createdAt: 0, ipHash: nil, label: nil)

        #expect(bare.displayDevice == "Unknown device")
        #expect(bare.displayLocation == nil)
        #expect(event(id: "sev_2", createdAt: 0, ipHash: "").displayLocation == nil)
    }

    @Test func sortingPutsTheNewestFirst() {
        let sorted = [
            event(id: "old", createdAt: 100),
            event(id: "newest", createdAt: 900),
            event(id: "middle", createdAt: 500),
        ].sortedForDisplay()

        #expect(sorted.map(\.id) == ["newest", "middle", "old"])
    }
}

@Suite struct MusubiRecoveryStatusTests {
    @Test func usedIsWhatTheSetHasSpent() {
        let status = MusubiRecoveryStatus(active: 4, total: 10, generatedAt: nil)

        #expect(status.hasCodes)
        #expect(status.used == 6)
    }

    /// An account that has never generated a set. `hasCodes` false is what
    /// drives the "you have none" copy, and `isRunningLow` must not also
    /// fire — one warning, not two contradictory ones.
    @Test func anAccountWithNoCodesIsNotAlsoRunningLow() {
        let status = MusubiRecoveryStatus(active: 0, total: 0, generatedAt: nil)

        #expect(!status.hasCodes)
        #expect(!status.isRunningLow)
        #expect(status.used == 0)
    }

    @Test func runningLowStartsAtThreeLeft() {
        #expect(MusubiRecoveryStatus(active: 4, total: 10, generatedAt: nil).isRunningLow == false)
        #expect(MusubiRecoveryStatus(active: 3, total: 10, generatedAt: nil).isRunningLow)
        #expect(MusubiRecoveryStatus(active: 0, total: 10, generatedAt: nil).isRunningLow)
    }

    /// Counts can only disagree in one direction honestly, but a server that
    /// reported more active than total must not produce a negative "used".
    @Test func usedNeverGoesNegative() {
        #expect(MusubiRecoveryStatus(active: 12, total: 10, generatedAt: nil).used == 0)
    }
}
