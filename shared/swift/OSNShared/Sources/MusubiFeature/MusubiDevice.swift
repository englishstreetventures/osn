import Foundation
import OSNAPI

/// One signed-in session, as the devices screen shows it.
///
/// The wire payload carries Unix **seconds** (`sessionSummary` in
/// `osn/api/src/routes/auth/response-schemas.ts` says so, and the spec types
/// them as plain numbers, so the generator hands over `Double` rather than
/// `Date`). Converting here means no view does date arithmetic on a bare
/// number.
public struct MusubiDevice: Identifiable, Equatable, Sendable {
    public let id: String
    /// The server's coarse user-agent label (`"iPhone · Safari"` and the
    /// like). `nil` for a session created before labelling, or by a client
    /// that sent no user-agent — shown as "Unknown device" rather than
    /// dropped, because an unlabelled session is exactly the one a user
    /// most wants to see and revoke.
    public let label: String?
    public let createdAt: Date
    /// `nil` until the session is used a second time.
    public let lastUsedAt: Date?
    public let expiresAt: Date
    /// True for the session this app is running on. It sorts first and
    /// revoking it signs the app out.
    public let isCurrent: Bool

    public init(
        id: String,
        label: String?,
        createdAt: Date,
        lastUsedAt: Date?,
        expiresAt: Date,
        isCurrent: Bool
    ) {
        self.id = id
        self.label = label
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.expiresAt = expiresAt
        self.isCurrent = isCurrent
    }

    public var displayLabel: String { label ?? "Unknown device" }

    /// Falls back to `createdAt`: a session that has never been used again
    /// was last used when it was made.
    public var lastActive: Date { lastUsedAt ?? createdAt }
}

extension MusubiDevice {
    public init(_ payload: Operations.ListSessions.Output.Ok.Body.JsonPayload.SessionsPayloadPayload) {
        self.init(
            id: payload.id,
            label: payload.uaLabel,
            createdAt: Date(timeIntervalSince1970: payload.createdAt),
            lastUsedAt: payload.lastUsedAt.map(Date.init(timeIntervalSince1970:)),
            expiresAt: Date(timeIntervalSince1970: payload.expiresAt),
            isCurrent: payload.isCurrent
        )
    }
}

extension Array where Element == MusubiDevice {
    /// This device first, then the rest most-recently-active first.
    ///
    /// The server already sorts by `lastUsedAt` descending, but that leaves
    /// the current session wherever its own last use falls — and "which one
    /// am I?" is the first question the screen has to answer, so it is
    /// pinned to the top here rather than hunted for in the list.
    public func sortedForDisplay() -> [MusubiDevice] {
        sorted { lhs, rhs in
            if lhs.isCurrent != rhs.isCurrent { return lhs.isCurrent }
            return lhs.lastActive > rhs.lastActive
        }
    }
}
