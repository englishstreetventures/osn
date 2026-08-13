import Foundation
import OSNAPI

/// One thing that happened to the account which the user is owed a look at:
/// a passkey added, a recovery code spent, a sign-in approved from another
/// device.
///
/// `GET /account/security-events` returns **unacknowledged events only**
/// (`osn/api/src/routes/auth/security-events.ts`), so this is a to-read
/// list, not a history. Acknowledging is what removes a row, and there is no
/// way back to it from the app.
///
/// Timestamps are Unix **seconds** typed as `Double`, like the session
/// routes and unlike the passkey routes' `Int`.
public struct MusubiSecurityEvent: Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: SecurityEventKind
    public let createdAt: Date
    /// The server's coarse user-agent label for the device that caused the
    /// event. `nil` when the request carried no user-agent.
    public let deviceLabel: String?
    /// An HMAC-peppered hash of the source IP, never the IP. Shown only as
    /// a short prefix — two events from the same place match, and that is
    /// the whole question a user can answer with it.
    public let ipHash: String?

    public init(
        id: String,
        kind: SecurityEventKind,
        createdAt: Date,
        deviceLabel: String?,
        ipHash: String?
    ) {
        self.id = id
        self.kind = kind
        self.createdAt = createdAt
        self.deviceLabel = deviceLabel
        self.ipHash = ipHash
    }

    public var title: String { kind.title }

    public var systemImage: String { kind.systemImage }

    public var displayDevice: String { deviceLabel ?? "Unknown device" }

    /// First 8 characters of the hash. The full 64 says nothing more to a
    /// human and reads as a wall.
    public var displayLocation: String? {
        guard let ipHash, !ipHash.isEmpty else { return nil }
        return String(ipHash.prefix(8))
    }
}

/// The server's `SecurityEventKind` union
/// (`shared/observability/src/metrics/attrs.ts:137-151`), with an `other`
/// case.
///
/// The wire type is a plain string, and a new kind on the server must not
/// make the feed unreadable on an old client — the whole point of the screen
/// is that the user sees everything. So an unrecognised kind is shown with
/// its own name tidied up rather than dropped.
public enum SecurityEventKind: Equatable, Sendable {
    case recoveryCodeGenerate
    case recoveryCodeConsume
    case recoveryCodeLockout
    case passkeyRegister
    case passkeyDelete
    case crossDeviceLogin
    case accountDeletionScheduled
    case accountDeletionCancelled
    case accountDeletionCompleted
    case appDeletionScheduled
    case appDeletionCancelled
    case appDeletionCompleted
    case other(String)

    public init(wire: String) {
        switch wire {
        case "recovery_code_generate": self = .recoveryCodeGenerate
        case "recovery_code_consume": self = .recoveryCodeConsume
        case "recovery_code_lockout": self = .recoveryCodeLockout
        case "passkey_register": self = .passkeyRegister
        case "passkey_delete": self = .passkeyDelete
        case "cross_device_login": self = .crossDeviceLogin
        case "account_deletion_scheduled": self = .accountDeletionScheduled
        case "account_deletion_cancelled": self = .accountDeletionCancelled
        case "account_deletion_completed": self = .accountDeletionCompleted
        case "app_deletion_scheduled": self = .appDeletionScheduled
        case "app_deletion_cancelled": self = .appDeletionCancelled
        case "app_deletion_completed": self = .appDeletionCompleted
        default: self = .other(wire)
        }
    }

    public var wire: String {
        switch self {
        case .recoveryCodeGenerate: "recovery_code_generate"
        case .recoveryCodeConsume: "recovery_code_consume"
        case .recoveryCodeLockout: "recovery_code_lockout"
        case .passkeyRegister: "passkey_register"
        case .passkeyDelete: "passkey_delete"
        case .crossDeviceLogin: "cross_device_login"
        case .accountDeletionScheduled: "account_deletion_scheduled"
        case .accountDeletionCancelled: "account_deletion_cancelled"
        case .accountDeletionCompleted: "account_deletion_completed"
        case .appDeletionScheduled: "app_deletion_scheduled"
        case .appDeletionCancelled: "app_deletion_cancelled"
        case .appDeletionCompleted: "app_deletion_completed"
        case .other(let wire): wire
        }
    }

    public var title: String {
        switch self {
        case .recoveryCodeGenerate: "New recovery codes made"
        case .recoveryCodeConsume: "A recovery code was used"
        case .recoveryCodeLockout: "Too many wrong recovery codes"
        case .passkeyRegister: "Passkey added"
        case .passkeyDelete: "Passkey removed"
        case .crossDeviceLogin: "Signed in from another device"
        case .accountDeletionScheduled: "Account deletion scheduled"
        case .accountDeletionCancelled: "Account deletion called off"
        case .accountDeletionCompleted: "Account deleted"
        case .appDeletionScheduled: "App data deletion scheduled"
        case .appDeletionCancelled: "App data deletion called off"
        case .appDeletionCompleted: "App data deleted"
        // `recovery_code_consume` -> "Recovery code consume". Not English,
        // but it names the thing, which beats hiding it.
        case .other(let wire): Self.humanise(wire)
        }
    }

    public var systemImage: String {
        switch self {
        case .recoveryCodeGenerate, .recoveryCodeConsume: "key.horizontal"
        case .recoveryCodeLockout: "lock.trianglebadge.exclamationmark"
        case .passkeyRegister: "person.badge.key"
        case .passkeyDelete: "person.badge.minus"
        case .crossDeviceLogin: "qrcode"
        case .accountDeletionScheduled, .appDeletionScheduled: "clock.badge.exclamationmark"
        case .accountDeletionCancelled, .appDeletionCancelled: "arrow.uturn.backward"
        case .accountDeletionCompleted, .appDeletionCompleted: "trash"
        case .other: "exclamationmark.circle"
        }
    }

    private static func humanise(_ wire: String) -> String {
        let words = wire.split(separator: "_").joined(separator: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}

extension MusubiSecurityEvent {
    public init(_ payload: Operations.ListSecurityEvents.Output.Ok.Body.JsonPayload.EventsPayloadPayload) {
        self.init(
            id: payload.id,
            kind: SecurityEventKind(wire: payload.kind),
            createdAt: Date(timeIntervalSince1970: payload.createdAt),
            deviceLabel: payload.uaLabel,
            ipHash: payload.ipHash
        )
    }
}

extension Array where Element == MusubiSecurityEvent {
    /// Newest first. The server already sorts this way; re-sorting costs
    /// nothing and means the screen doesn't depend on it.
    public func sortedForDisplay() -> [MusubiSecurityEvent] {
        sorted { $0.createdAt > $1.createdAt }
    }
}
