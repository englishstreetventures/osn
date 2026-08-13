import Foundation
import OSNAPI

/// Whether this account is on its way out, and when it stops being
/// recoverable.
///
/// `GET /account/deletion-status` answers for a live account too —
/// `{ scheduled: false }`, not a 404 — because this backs a banner that is
/// polled, and "nothing pending" has to be an ordinary success
/// (`osn/api/src/routes/account-erasure.ts`).
public enum MusubiDeletionStatus: Equatable, Sendable {
    case none
    /// `scheduledFor` is when the hard delete becomes eligible; until then a
    /// restore takes the account back whole.
    case scheduled(scheduledFor: Date, softDeletedAt: Date)

    public var isScheduled: Bool {
        if case .scheduled = self { return true }
        return false
    }

    public var scheduledFor: Date? {
        if case .scheduled(let date, _) = self { return date }
        return nil
    }
}

/// What `DELETE /account` answers with: a 202, because nothing is erased
/// yet. The account is tombstoned and the hard delete becomes eligible when
/// the grace window closes at `scheduledFor`.
public struct MusubiDeletionSchedule: Equatable, Sendable {
    public let scheduledFor: Date
    /// `true` when a deletion was already pending — the call is idempotent
    /// and this is the second press, not a failure.
    public let alreadyPending: Bool

    public init(scheduledFor: Date, alreadyPending: Bool) {
        self.scheduledFor = scheduledFor
        self.alreadyPending = alreadyPending
    }
}

extension MusubiDeletionStatus {
    /// The 200 body is an `anyOf` of two closed shapes, and `anyOf` means
    /// *at least* one branch matched, not exactly one: a scheduled payload
    /// satisfies the un-scheduled branch too, since that branch requires
    /// only `scheduled`. So the richer branch is read first and the poorer
    /// one is the fallback — never the other way round.
    public init(_ payload: Operations.GetAccountDeletionStatus.Output.Ok.Body.JsonPayload) {
        if let scheduled = payload.value2, scheduled.scheduled {
            self = .scheduled(
                scheduledFor: Date(timeIntervalSince1970: scheduled.scheduledFor),
                softDeletedAt: Date(timeIntervalSince1970: scheduled.softDeletedAt)
            )
        } else {
            self = .none
        }
    }
}

extension MusubiDeletionSchedule {
    public init(_ payload: Operations.RequestAccountDeletion.Output.Accepted.Body.JsonPayload) {
        self.init(
            scheduledFor: Date(timeIntervalSince1970: payload.scheduledFor),
            alreadyPending: payload.alreadyPending
        )
    }
}
