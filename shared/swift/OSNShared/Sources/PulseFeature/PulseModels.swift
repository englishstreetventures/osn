import Foundation
import PulseAPI

/// A latitude/longitude pair.
///
/// The wire shape is two independent nullable numbers. They are paired here
/// because a lone latitude cannot be placed on a map — anything that wants
/// coordinates wants both. An event carrying only one of the two therefore
/// reads as having no coordinate at all.
public struct PulseCoordinate: Equatable, Sendable {
    public let latitude: Double
    public let longitude: Double

    public init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }

    fileprivate init?(latitude: Double?, longitude: Double?) {
        guard let latitude, let longitude else { return nil }
        self.init(latitude: latitude, longitude: longitude)
    }
}

/// A ticket price.
///
/// `minorUnits` is cents/pence/etc., not whole currency units — "$18.50" is
/// `1850` (see the `price_amount` column comment in
/// `pulse/db/src/schema/events.ts`). Format it with a currency-aware
/// formatter; never print it raw.
///
/// Amount and currency are paired for the same reason the DB pairs them:
/// "both columns set or both null — enforced at the service layer". An
/// amount with no currency is not a price anyone can display.
///
/// The generated type carries the amount as `Double` despite the column
/// being an integer, so it is rounded on the way in — the same judgment
/// already made for `PulseRsvpCounts`.
public struct PulsePrice: Equatable, Sendable {
    public let minorUnits: Int
    public let currency: String

    /// Zero is free, per the same column comment: "null OR 0 → Free".
    public var isFree: Bool { minorUnits == 0 }

    public init(minorUnits: Int, currency: String) {
        self.minorUnits = minorUnits
        self.currency = currency
    }

    fileprivate init?(amount: Double?, currency: String?) {
        guard let amount, let currency else { return nil }
        self.init(minorUnits: Int(amount.rounded()), currency: currency)
    }
}

/// `cancelledAt` and `hardDeleteAt` are unix *seconds* — plain integer
/// columns, not the `timestamp` columns the four `date-time` fields come
/// from, so the generator emits them as `Double?` and they need converting
/// by hand. Confirmed against `pulse/db/src/schema/events.ts` and
/// `serializeEvent` in `pulse/api/src/routes/events.ts`, which deliberately
/// passes both through without `.toISOString()`.
private func date(unixSeconds: Double?) -> Date? {
    unixSeconds.map { Date(timeIntervalSince1970: $0) }
}

/// App-level event model shared by Explore and Event detail.
///
/// `discoverEvents` and `getEventById` each generate their own,
/// structurally-identical but nominally distinct payload type
/// (`Operations.DiscoverEvents...EventsPayloadPayload` and
/// `Operations.GetEventById...EventPayload`) — this bridges both into one
/// shape the views can share.
///
/// Every field of `eventResponseSchema` is mapped, in the order the schema
/// declares them. That was not true when this file was written: the
/// generator dropped every nullable property on the floor, so only the 13
/// non-nullable fields existed and the rest — `description`, `location`,
/// coordinates, price, `cancellationReason` and the others — had nowhere to
/// go. The spec now spells nullability as `type: ["string", "null"]` rather
/// than `anyOf: [X, {type: "null"}]`, which the generator understands, and
/// the missing 15 arrived with it. See `a5-notes.md`.
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

    /// Why a `cancelled` event was cancelled. `hostLeft` is the one the
    /// public UI words differently: the event was not called off on its own
    /// merits, the host deleted their account and it went with them.
    public enum CancellationReason: String, Equatable, Sendable {
        case hostLeft = "host_left"
        case organiser
        case admin
    }

    public let id: String
    public let title: String
    public let description: String?
    public let location: String?
    public let venue: String?
    public let venueId: String?
    public let coordinate: PulseCoordinate?
    public let category: String?
    public let startTime: Date
    public let endTime: Date?
    public let status: Status
    public let imageUrl: String?
    public let price: PulsePrice?
    public let visibility: Visibility
    public let guestListVisibility: GuestListVisibility
    public let joinPolicy: JoinPolicy
    public let allowInterested: Bool
    public let commsChannels: String
    public let chatId: String?
    public let seriesId: String?
    public let instanceOverride: Bool
    public let createdByProfileId: String
    public let createdByName: String?
    public let createdByAvatar: String?
    public let cancelledAt: Date?
    public let hardDeleteAt: Date?
    public let cancellationReason: CancellationReason?
    public let createdAt: Date
    public let updatedAt: Date

    /// No price at all is free, and so is a price of zero — both spellings
    /// occur (see `PulsePrice.isFree`).
    public var isFree: Bool { price?.isFree ?? true }
}

// The two payload types nest their own copy of each enum, so every case
// mapping has to be written twice. They convert by exhaustive `switch` rather
// than by `init(rawValue:)` — the raw values do match, but a `switch` is the
// only version that fails to compile when the spec grows a case, which is
// exactly when someone needs to be told.
extension PulseEvent.Status {
    init(_ generated: Operations.DiscoverEvents.Output.Ok.Body.JsonPayload.EventsPayloadPayload.StatusPayload) {
        switch generated {
        case .upcoming: self = .upcoming
        case .ongoing: self = .ongoing
        case .maybeFinished: self = .maybeFinished
        case .finished: self = .finished
        case .cancelled: self = .cancelled
        }
    }

    init(_ generated: Operations.GetEventById.Output.Ok.Body.JsonPayload.EventPayload.StatusPayload) {
        switch generated {
        case .upcoming: self = .upcoming
        case .ongoing: self = .ongoing
        case .maybeFinished: self = .maybeFinished
        case .finished: self = .finished
        case .cancelled: self = .cancelled
        }
    }
}

extension PulseEvent.Visibility {
    init(_ generated: Operations.DiscoverEvents.Output.Ok.Body.JsonPayload.EventsPayloadPayload.VisibilityPayload) {
        switch generated {
        case ._public: self = .public
        case ._private: self = .private
        }
    }

    init(_ generated: Operations.GetEventById.Output.Ok.Body.JsonPayload.EventPayload.VisibilityPayload) {
        switch generated {
        case ._public: self = .public
        case ._private: self = .private
        }
    }
}

extension PulseEvent.GuestListVisibility {
    init(
        _ generated: Operations.DiscoverEvents.Output.Ok.Body.JsonPayload.EventsPayloadPayload
            .GuestListVisibilityPayload
    ) {
        switch generated {
        case ._public: self = .public
        case .connections: self = .connections
        case ._private: self = .private
        }
    }

    init(_ generated: Operations.GetEventById.Output.Ok.Body.JsonPayload.EventPayload.GuestListVisibilityPayload) {
        switch generated {
        case ._public: self = .public
        case .connections: self = .connections
        case ._private: self = .private
        }
    }
}

extension PulseEvent.JoinPolicy {
    init(_ generated: Operations.DiscoverEvents.Output.Ok.Body.JsonPayload.EventsPayloadPayload.JoinPolicyPayload) {
        switch generated {
        case .open: self = .open
        case .guestList: self = .guestList
        }
    }

    init(_ generated: Operations.GetEventById.Output.Ok.Body.JsonPayload.EventPayload.JoinPolicyPayload) {
        switch generated {
        case .open: self = .open
        case .guestList: self = .guestList
        }
    }
}

extension PulseEvent.CancellationReason {
    init(
        _ generated: Operations.DiscoverEvents.Output.Ok.Body.JsonPayload.EventsPayloadPayload
            .CancellationReasonPayload
    ) {
        switch generated {
        case .hostLeft: self = .hostLeft
        case .organiser: self = .organiser
        case .admin: self = .admin
        }
    }

    init(_ generated: Operations.GetEventById.Output.Ok.Body.JsonPayload.EventPayload.CancellationReasonPayload) {
        switch generated {
        case .hostLeft: self = .hostLeft
        case .organiser: self = .organiser
        case .admin: self = .admin
        }
    }
}

extension PulseEvent {
    public init(_ payload: Operations.DiscoverEvents.Output.Ok.Body.JsonPayload.EventsPayloadPayload) {
        self.init(
            id: payload.id,
            title: payload.title,
            description: payload.description,
            location: payload.location,
            venue: payload.venue,
            venueId: payload.venueId,
            coordinate: PulseCoordinate(latitude: payload.latitude, longitude: payload.longitude),
            category: payload.category,
            startTime: payload.startTime,
            endTime: payload.endTime,
            status: Status(payload.status),
            imageUrl: payload.imageUrl,
            price: PulsePrice(amount: payload.priceAmount, currency: payload.priceCurrency),
            visibility: Visibility(payload.visibility),
            guestListVisibility: GuestListVisibility(payload.guestListVisibility),
            joinPolicy: JoinPolicy(payload.joinPolicy),
            allowInterested: payload.allowInterested,
            commsChannels: payload.commsChannels,
            chatId: payload.chatId,
            seriesId: payload.seriesId,
            instanceOverride: payload.instanceOverride,
            createdByProfileId: payload.createdByProfileId,
            createdByName: payload.createdByName,
            createdByAvatar: payload.createdByAvatar,
            cancelledAt: date(unixSeconds: payload.cancelledAt),
            hardDeleteAt: date(unixSeconds: payload.hardDeleteAt),
            cancellationReason: payload.cancellationReason.map(CancellationReason.init),
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt
        )
    }

    public init(_ payload: Operations.GetEventById.Output.Ok.Body.JsonPayload.EventPayload) {
        self.init(
            id: payload.id,
            title: payload.title,
            description: payload.description,
            location: payload.location,
            venue: payload.venue,
            venueId: payload.venueId,
            coordinate: PulseCoordinate(latitude: payload.latitude, longitude: payload.longitude),
            category: payload.category,
            startTime: payload.startTime,
            endTime: payload.endTime,
            status: Status(payload.status),
            imageUrl: payload.imageUrl,
            price: PulsePrice(amount: payload.priceAmount, currency: payload.priceCurrency),
            visibility: Visibility(payload.visibility),
            guestListVisibility: GuestListVisibility(payload.guestListVisibility),
            joinPolicy: JoinPolicy(payload.joinPolicy),
            allowInterested: payload.allowInterested,
            commsChannels: payload.commsChannels,
            chatId: payload.chatId,
            seriesId: payload.seriesId,
            instanceOverride: payload.instanceOverride,
            createdByProfileId: payload.createdByProfileId,
            createdByName: payload.createdByName,
            createdByAvatar: payload.createdByAvatar,
            cancelledAt: date(unixSeconds: payload.cancelledAt),
            hardDeleteAt: date(unixSeconds: payload.hardDeleteAt),
            cancellationReason: payload.cancellationReason.map(CancellationReason.init),
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt
        )
    }
}

/// Keyset pagination cursor for `discoverEvents`, as the server issues it.
///
/// This used to be rebuilt on the client from the last loaded event, because
/// the response's `nextCursor` is nullable and the generator was dropping it
/// along with every other nullable field. The reconstruction was right — the
/// contract is `cursorStartTime`/`cursorId` echoing the last item — but the
/// server's own value is authoritative, and only it can say "no more pages"
/// without a wasted request.
public struct EventPageCursor: Equatable, Sendable {
    public let startTime: Date
    public let id: String

    public init(startTime: Date, id: String) {
        self.startTime = startTime
        self.id = id
    }

    public init(_ payload: Operations.DiscoverEvents.Output.Ok.Body.JsonPayload.NextCursorPayload) {
        self.init(startTime: payload.startTime, id: payload.id)
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

/// An RSVP as returned by `rsvpToEvent` — the raw `event_rsvps` row, with no
/// `profile` join and no `isCloseFriend` stamp (a different shape from the
/// guest-list RSVP the same file's `rsvpResponseSchema` describes).
///
/// `invitedByProfileId` and the four `shareSource*` fields were recorded here
/// as absent from the generated body. They never were: they are nullable, and
/// the generator was dropping every nullable property. See `a5-notes.md`.
///
/// The share sources stay `String?` rather than becoming an enum. The server
/// writes a closed set (`pulse/api/src/lib/shareSource.ts`), but the response
/// schema types them as plain strings, and a client that narrowed an open
/// wire type to a closed one would have to invent a case for values it does
/// not recognise.
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
    public let invitedByProfileId: String?
    public let shareSourceFirst: String?
    public let shareSourceFirstSeenAt: Date?
    public let shareSourceLast: String?
    public let shareSourceLastSeenAt: Date?
    public let createdAt: Date

    public init(_ payload: Operations.RsvpToEvent.Output.Ok.Body.JsonPayload.RsvpPayload) {
        id = payload.id
        eventId = payload.eventId
        profileId = payload.profileId
        invitedByProfileId = payload.invitedByProfileId
        shareSourceFirst = payload.shareSourceFirst
        shareSourceFirstSeenAt = payload.shareSourceFirstSeenAt
        shareSourceLast = payload.shareSourceLast
        shareSourceLastSeenAt = payload.shareSourceLastSeenAt
        createdAt = payload.createdAt
        switch payload.status {
        case .going: status = .going
        case .maybe: status = .maybe
        case .notGoing: status = .notGoing
        case .invited: status = .invited
        }
    }

    /// The optimistic value to show immediately after requesting `target`,
    /// before the server responds. Everything the server assigns — the id,
    /// the invite and share-source attribution, the timestamp — is empty
    /// until it answers.
    public init(optimistic target: PulseRsvpTarget, eventId: String, profileId: String) {
        id = ""
        self.eventId = eventId
        self.profileId = profileId
        status = Status(target)
        invitedByProfileId = nil
        shareSourceFirst = nil
        shareSourceFirstSeenAt = nil
        shareSourceLast = nil
        shareSourceLastSeenAt = nil
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
