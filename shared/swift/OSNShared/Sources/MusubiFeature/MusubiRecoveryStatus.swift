import Foundation
import OSNAPI

/// How many recovery codes the account has left, as the security screen
/// shows it.
///
/// `GET /recovery/status` is the one route on this screen with **no**
/// step-up gate, deliberately: the answer is what tells a user whether a
/// ceremony is worth starting, and it carries counts, never a code.
///
/// The counts arrive as `Double` because the spec types them as plain
/// numbers. They are whole codes, so they are narrowed here once rather
/// than in every view.
public struct MusubiRecoveryStatus: Equatable, Sendable {
    /// Codes still unspent.
    public let active: Int
    /// Codes in the current set. A set is replaced whole, so this is 10
    /// after any generate.
    public let total: Int
    /// When the current set was made. `nil` when the account has never
    /// generated one.
    public let generatedAt: Date?

    public init(active: Int, total: Int, generatedAt: Date?) {
        self.active = active
        self.total = total
        self.generatedAt = generatedAt
    }

    public var hasCodes: Bool { total > 0 }

    public var used: Int { Swift.max(0, total - active) }

    /// Few enough left that the user should make a new set before they are
    /// locked out of their own fallback.
    public var isRunningLow: Bool { hasCodes && active <= 3 }
}

extension MusubiRecoveryStatus {
    public init(_ payload: Operations.GetRecoveryStatus.Output.Ok.Body.JsonPayload) {
        self.init(
            active: Int(payload.active),
            total: Int(payload.total),
            generatedAt: payload.generatedAt.map(Date.init(timeIntervalSince1970:))
        )
    }
}
