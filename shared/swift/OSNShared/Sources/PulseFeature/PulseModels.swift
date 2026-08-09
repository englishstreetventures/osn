import Foundation
import PulseAPI

/// App-level event model shared by Explore and Event detail.
///
/// `discoverEvents` and `getEventById` each generate their own,
/// structurally-identical but nominally distinct payload type
/// (`Operations.DiscoverEvents...EventsPayloadPayload` and
/// `Operations.GetEventById...EventPayload`) — this bridges both into one
/// shape the views can share. Fields mirror only what the generated types
/// actually carry (13 fields, confirmed against `Types.swift`); several
/// fields the brief describes — `description`, `location`, `venue`,
/// `category`, `endTime`, `imageUrl`, `priceAmount`/`priceCurrency`,
/// `createdByName`/`createdByAvatar`, `cancelledAt`, `cancellationReason` —
/// are not present in the generated schema and so have no home here. See
/// `a5-notes.md`.
public struct PulseEvent: Identifiable, Equatable, Sendable {
    public enum Status: String, Equatable, Sendable {
        case upcoming
        case ongoing
        case finished
        case cancelled
        case maybeFinished = "maybe_finished"
    }

    public enum Visibility: String, Equatable, Sendable {
        case `public`
        case `private`
    }

    public enum GuestListVisibility: String, Equatable, Sendable {
        case `public`
        case connections
        case `private`
    }

    public enum JoinPolicy: String, Equatable, Sendable {
        case open
        case guestList = "guest_list"
    }

    public let id: String
    public let title: String
    public let startTime: Date
    public let status: Status
    public let visibility: Visibility
    public let guestListVisibility: GuestListVisibility
    public let joinPolicy: JoinPolicy
    public let allowInterested: Bool
    public let commsChannels: String
    public let instanceOverride: Bool
    public let createdByProfileId: String
    public let createdAt: Date
    public let updatedAt: Date
}

extension PulseEvent {
    public init(_ payload: Operations.DiscoverEvents.Output.Ok.Body.JsonPayload.EventsPayloadPayload) {
        id = payload.id
        title = payload.title
        startTime = payload.startTime
        switch payload.status {
        case .upcoming: status = .upcoming
        case .ongoing: status = .ongoing
        case .finished: status = .finished
        case .cancelled: status = .cancelled
        case .maybeFinished: status = .maybeFinished
        }
        switch payload.visibility {
        case ._public: visibility = .public
        case ._private: visibility = .private
        }
        switch payload.guestListVisibility {
        case ._public: guestListVisibility = .public
        case .connections: guestListVisibility = .connections
        case ._private: guestListVisibility = .private
        }
        switch payload.joinPolicy {
        case .open: joinPolicy = .open
        case .guestList: joinPolicy = .guestList
        }
        allowInterested = payload.allowInterested
        commsChannels = payload.commsChannels
        instanceOverride = payload.instanceOverride
        createdByProfileId = payload.createdByProfileId
        createdAt = payload.createdAt
        updatedAt = payload.updatedAt
    }

    public init(_ payload: Operations.GetEventById.Output.Ok.Body.JsonPayload.EventPayload) {
        id = payload.id
        title = payload.title
        startTime = payload.startTime
        switch payload.status {
        case .upcoming: status = .upcoming
        case .ongoing: status = .ongoing
        case .finished: status = .finished
        case .cancelled: status = .cancelled
        case .maybeFinished: status = .maybeFinished
        }
        switch payload.visibility {
        case ._public: visibility = .public
        case ._private: visibility = .private
        }
        switch payload.guestListVisibility {
        case ._public: guestListVisibility = .public
        case .connections: guestListVisibility = .connections
        case ._private: guestListVisibility = .private
        }
        switch payload.joinPolicy {
        case .open: joinPolicy = .open
        case .guestList: joinPolicy = .guestList
        }
        allowInterested = payload.allowInterested
        commsChannels = payload.commsChannels
        instanceOverride = payload.instanceOverride
        createdByProfileId = payload.createdByProfileId
        createdAt = payload.createdAt
        updatedAt = payload.updatedAt
    }
}

/// Client-derived keyset pagination cursor for `discoverEvents`. The
/// generated response has no `nextCursor` field — the API's own pagination
/// contract is `cursorStartTime`/`cursorId` echoing the last item's
/// `startTime`/`id` (see `a5-notes.md`), so this is built from the last
/// loaded `PulseEvent`, not decoded from the server.
public struct EventPageCursor: Equatable, Sendable {
    public let startTime: Date
    public let id: String

    public init(startTime: Date, id: String) {
        self.startTime = startTime
        self.id = id
    }
}

extension Array where Element == PulseEvent {
    /// The keyset cursor for fetching the page after this one, or `nil` if
    /// this page is empty.
    public var keysetCursor: EventPageCursor? {
        guard let last else { return nil }
        return EventPageCursor(startTime: last.startTime, id: last.id)
    }
}

/// The three RSVP statuses a guest can set. A distinct type from
/// `PulseRsvp.Status` because `rsvpToEvent`'s request body only accepts
/// three cases — `invited` is a response-only state the server assigns, not
/// something a client can request (confirmed against `Types.swift`: the
/// generated request `StatusPayload` and response `StatusPayload` are two
/// different nested types with different case counts despite the same
/// name).
public enum PulseRsvpTarget: String, Equatable, Sendable, CaseIterable {
    case going
    case maybe
    case notGoing = "not_going"

    var generated: Operations.RsvpToEvent.Input.Body.JsonPayload.StatusPayload {
        switch self {
        case .going: .going
        case .maybe: .maybe
        case .notGoing: .notGoing
        }
    }
}

/// An RSVP as returned by `rsvpToEvent` — 5 fields, confirmed against
/// `Types.swift`. The brief's stated shape additionally lists
/// `invitedByProfileId` and four `shareSource*` fields; none of those are in
/// the generated response body.
public struct PulseRsvp: Equatable, Sendable {
    public enum Status: String, Equatable, Sendable {
        case going
        case maybe
        case invited
        case notGoing = "not_going"

        init(_ target: PulseRsvpTarget) {
            switch target {
            case .going: self = .going
            case .maybe: self = .maybe
            case .notGoing: self = .notGoing
            }
        }
    }

    public let id: String
    public let eventId: String
    public let profileId: String
    public let status: Status
    public let createdAt: Date

    public init(_ payload: Operations.RsvpToEvent.Output.Ok.Body.JsonPayload.RsvpPayload) {
        id = payload.id
        eventId = payload.eventId
        profileId = payload.profileId
        createdAt = payload.createdAt
        switch payload.status {
        case .going: status = .going
        case .maybe: status = .maybe
        case .notGoing: status = .notGoing
        case .invited: status = .invited
        }
    }

    /// The optimistic value to show immediately after requesting `target`,
    /// before the server responds.
    public init(optimistic target: PulseRsvpTarget, eventId: String, profileId: String) {
        id = ""
        self.eventId = eventId
        self.profileId = profileId
        status = Status(target)
        createdAt = Date(timeIntervalSince1970: 0)
    }
}

/// RSVP counts for an event. The generated `CountsPayload` carries all four
/// as `Double` (confirmed against `Types.swift`), not `Int`, despite
/// counting discrete RSVPs — rounded to the nearest whole number for
/// display, a judgment call recorded in `a5-notes.md`.
public struct PulseRsvpCounts: Equatable, Sendable {
    public let going: Int
    public let maybe: Int
    public let notGoing: Int
    public let invited: Int

    public init(_ payload: Operations.GetEventRsvpCounts.Output.Ok.Body.JsonPayload.CountsPayload) {
        going = Int(payload.going.rounded())
        maybe = Int(payload.maybe.rounded())
        notGoing = Int(payload.notGoing.rounded())
        invited = Int(payload.invited.rounded())
    }
}
