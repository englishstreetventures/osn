import Foundation
import OSNAuth

/// One registered passkey, as the passkeys screen shows it.
///
/// `PasskeySummary` carries Unix **seconds** as `Int` (the management route
/// hands back integers, unlike the session routes' `Double`), so the
/// conversion happens here and no view does date arithmetic on a bare
/// number.
public struct MusubiPasskey: Identifiable, Equatable, Sendable {
    public let id: String
    /// User-set name. `nil` for a passkey enrolled before labelling, or one
    /// the user never named.
    public let label: String?
    public let createdAt: Date
    /// `nil` until the passkey is used to sign in.
    public let lastUsedAt: Date?
    /// The authenticator says the credential *can* be backed up (iCloud
    /// Keychain, a password manager) — not that it has been.
    public let backupEligible: Bool
    /// The authenticator says the credential *is* backed up. A passkey that
    /// is eligible but not backed up lives on one device only, which is the
    /// one worth warning about: lose the device, lose the account.
    public let backupState: Bool

    public init(
        id: String,
        label: String?,
        createdAt: Date,
        lastUsedAt: Date?,
        backupEligible: Bool,
        backupState: Bool
    ) {
        self.id = id
        self.label = label
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.backupEligible = backupEligible
        self.backupState = backupState
    }

    public var displayLabel: String { label ?? "Unnamed passkey" }

    /// Falls back to `createdAt`: a passkey never used again was last used
    /// when it was enrolled.
    public var lastActive: Date { lastUsedAt ?? createdAt }

    /// Synced to the user's keychain, so it survives losing this device.
    public var isSynced: Bool { backupState }

    /// Eligible for sync but not synced — the only state that costs the user
    /// their account if the device goes in a river.
    public var isDeviceBound: Bool { backupEligible && !backupState }
}

extension MusubiPasskey {
    /// The server sends `backupEligible`/`backupState` as optional: a
    /// credential enrolled by an authenticator that reported no backup flags
    /// has neither. Absent is read as false — claiming a passkey is synced
    /// when nobody said so is the one wrong answer here.
    public init(_ summary: PasskeySummary) {
        self.init(
            id: summary.id,
            label: summary.label,
            createdAt: Date(timeIntervalSince1970: TimeInterval(summary.createdAt)),
            lastUsedAt: summary.lastUsedAt.map { Date(timeIntervalSince1970: TimeInterval($0)) },
            backupEligible: summary.backupEligible ?? false,
            backupState: summary.backupState ?? false
        )
    }
}

extension Array where Element == MusubiPasskey {
    /// Most recently used first. Unlike the devices list there is no "this
    /// one" to pin: the screen can't know which credential the current
    /// session was signed in with, and the server doesn't say.
    public func sortedForDisplay() -> [MusubiPasskey] {
        sorted { $0.lastActive > $1.lastActive }
    }
}
