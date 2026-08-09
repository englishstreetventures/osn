import Foundation
import Testing
@testable import PulseFeature
@testable import PulseAPI

private let referenceDate = Date(timeIntervalSince1970: 1_700_000_000)

private func makeDiscoverEventsPayload(
    id: String = "event-1",
    status: Operations.DiscoverEvents.Output.Ok.Body.JsonPayload.EventsPayloadPayload.StatusPayload = .upcoming
) -> Operations.DiscoverEvents.Output.Ok.Body.JsonPayload.EventsPayloadPayload {
    .init(
        allowInterested: true,
        commsChannels: "email",
        createdAt: referenceDate,
        createdByProfileId: "profile-1",
        guestListVisibility: .connections,
        id: id,
        instanceOverride: false,
        joinPolicy: .open,
        startTime: referenceDate,
        status: status,
        title: "Rooftop Party",
        updatedAt: referenceDate,
        visibility: ._public
    )
}

/// Every field of `eventResponseSchema` populated, so a mapping that drops
/// one shows up as a failed expectation rather than as a `nil` nobody
/// notices. `cancelledAt`/`hardDeleteAt` are unix seconds, not `date-time`,
/// hence the bare numbers.
private func makeFullDiscoverEventsPayload()
    -> Operations.DiscoverEvents.Output.Ok.Body.JsonPayload.EventsPayloadPayload
{
    .init(
        allowInterested: true,
        cancellationReason: .hostLeft,
        cancelledAt: 1_700_000_500,
        category: "music",
        chatId: "chat-1",
        commsChannels: "email",
        createdAt: referenceDate,
        createdByAvatar: "https://cdn.example/avatar.png",
        createdByName: "Ada",
        createdByProfileId: "profile-1",
        description: "Sunset set on the roof",
        endTime: referenceDate.addingTimeInterval(7200),
        guestListVisibility: .connections,
        hardDeleteAt: 1_701_000_000,
        id: "event-1",
        imageUrl: "https://cdn.example/event.jpg",
        instanceOverride: true,
        joinPolicy: .guestList,
        latitude: -33.8688,
        location: "Sydney",
        longitude: 151.2093,
        priceAmount: 1850,
        priceCurrency: "AUD",
        seriesId: "series-1",
        startTime: referenceDate,
        status: .cancelled,
        title: "Rooftop Party",
        updatedAt: referenceDate,
        venue: "The Roof",
        venueId: "venue-1",
        visibility: ._private
    )
}

@Test func pulseEventMapsEveryDiscoverEventsField() {
    let event = PulseEvent(makeFullDiscoverEventsPayload())
    #expect(event.description == "Sunset set on the roof")
    #expect(event.location == "Sydney")
    #expect(event.venue == "The Roof")
    #expect(event.venueId == "venue-1")
    #expect(event.coordinate == PulseCoordinate(latitude: -33.8688, longitude: 151.2093))
    #expect(event.category == "music")
    #expect(event.endTime == referenceDate.addingTimeInterval(7200))
    #expect(event.imageUrl == "https://cdn.example/event.jpg")
    #expect(event.price == PulsePrice(minorUnits: 1850, currency: "AUD"))
    #expect(event.chatId == "chat-1")
    #expect(event.seriesId == "series-1")
    #expect(event.createdByName == "Ada")
    #expect(event.createdByAvatar == "https://cdn.example/avatar.png")
    #expect(event.cancellationReason == .hostLeft)
    #expect(event.visibility == .private)
    #expect(event.joinPolicy == .guestList)
    #expect(event.instanceOverride == true)
}

@Test func cancelledAtAndHardDeleteAtAreReadAsUnixSeconds() {
    let event = PulseEvent(makeFullDiscoverEventsPayload())
    #expect(event.cancelledAt == Date(timeIntervalSince1970: 1_700_000_500))
    #expect(event.hardDeleteAt == Date(timeIntervalSince1970: 1_701_000_000))
}

@Test func absentOptionalFieldsMapToNil() {
    let event = PulseEvent(makeDiscoverEventsPayload())
    #expect(event.description == nil)
    #expect(event.location == nil)
    #expect(event.venue == nil)
    #expect(event.venueId == nil)
    #expect(event.coordinate == nil)
    #expect(event.category == nil)
    #expect(event.endTime == nil)
    #expect(event.imageUrl == nil)
    #expect(event.price == nil)
    #expect(event.chatId == nil)
    #expect(event.seriesId == nil)
    #expect(event.createdByName == nil)
    #expect(event.createdByAvatar == nil)
    #expect(event.cancelledAt == nil)
    #expect(event.hardDeleteAt == nil)
    #expect(event.cancellationReason == nil)
}

@Test func halfACoordinateIsNoCoordinate() {
    var payload = makeFullDiscoverEventsPayload()
    payload.longitude = nil
    #expect(PulseEvent(payload).coordinate == nil)
}

@Test func anAmountWithoutACurrencyIsNoPrice() {
    var payload = makeFullDiscoverEventsPayload()
    payload.priceCurrency = nil
    #expect(PulseEvent(payload).price == nil)
}

@Test func zeroAndAbsentPriceBothReadAsFree() {
    var payload = makeFullDiscoverEventsPayload()
    payload.priceAmount = 0
    #expect(PulseEvent(payload).isFree == true)
    #expect(PulseEvent(makeDiscoverEventsPayload()).isFree == true)
    #expect(PulseEvent(makeFullDiscoverEventsPayload()).isFree == false)
}

@Test func pulseEventMapsDiscoverEventsPayloadFields() {
    let event = PulseEvent(makeDiscoverEventsPayload())
    #expect(event.id == "event-1")
    #expect(event.title == "Rooftop Party")
    #expect(event.status == .upcoming)
    #expect(event.visibility == .public)
    #expect(event.guestListVisibility == .connections)
    #expect(event.joinPolicy == .open)
    #expect(event.allowInterested == true)
    #expect(event.commsChannels == "email")
    #expect(event.instanceOverride == false)
    #expect(event.createdByProfileId == "profile-1")
    #expect(event.createdAt == referenceDate)
    #expect(event.updatedAt == referenceDate)
}

@Test func pulseEventMapsAllDiscoverEventsStatusCases() {
    #expect(PulseEvent(makeDiscoverEventsPayload(status: .upcoming)).status == .upcoming)
    #expect(PulseEvent(makeDiscoverEventsPayload(status: .ongoing)).status == .ongoing)
    #expect(PulseEvent(makeDiscoverEventsPayload(status: .finished)).status == .finished)
    #expect(PulseEvent(makeDiscoverEventsPayload(status: .cancelled)).status == .cancelled)
    #expect(PulseEvent(makeDiscoverEventsPayload(status: .maybeFinished)).status == .maybeFinished)
}

/// The same event, spelled in the detail endpoint's own payload type.
private func makeFullGetEventByIdPayload() -> Operations.GetEventById.Output.Ok.Body.JsonPayload.EventPayload {
    .init(
        allowInterested: true,
        cancellationReason: .hostLeft,
        cancelledAt: 1_700_000_500,
        category: "music",
        chatId: "chat-1",
        commsChannels: "email",
        createdAt: referenceDate,
        createdByAvatar: "https://cdn.example/avatar.png",
        createdByName: "Ada",
        createdByProfileId: "profile-1",
        description: "Sunset set on the roof",
        endTime: referenceDate.addingTimeInterval(7200),
        guestListVisibility: .connections,
        hardDeleteAt: 1_701_000_000,
        id: "event-1",
        imageUrl: "https://cdn.example/event.jpg",
        instanceOverride: true,
        joinPolicy: .guestList,
        latitude: -33.8688,
        location: "Sydney",
        longitude: 151.2093,
        priceAmount: 1850,
        priceCurrency: "AUD",
        seriesId: "series-1",
        startTime: referenceDate,
        status: .cancelled,
        title: "Rooftop Party",
        updatedAt: referenceDate,
        venue: "The Roof",
        venueId: "venue-1",
        visibility: ._private
    )
}

/// The point of the two bridges is that Explore and Event detail can share
/// one model, so the only interesting property is that they agree. Written
/// as a single equality rather than a second field-by-field sweep: the two
/// mappings are duplicated by necessity (the generated types nest their own
/// enums), and this is what catches one drifting from the other.
@Test func bothBridgesProduceTheSameEvent() {
    #expect(PulseEvent(makeFullDiscoverEventsPayload()) == PulseEvent(makeFullGetEventByIdPayload()))
}

@Test func pulseEventMapsAllCancellationReasons() {
    func reason(
        _ generated: Operations.GetEventById.Output.Ok.Body.JsonPayload.EventPayload.CancellationReasonPayload
    ) -> PulseEvent.CancellationReason? {
        var payload = makeFullGetEventByIdPayload()
        payload.cancellationReason = generated
        return PulseEvent(payload).cancellationReason
    }
    #expect(reason(.hostLeft) == .hostLeft)
    #expect(reason(.organiser) == .organiser)
    #expect(reason(.admin) == .admin)
}

@Test func eventPageCursorReadsTheServersNextCursor() {
    let payload = Operations.DiscoverEvents.Output.Ok.Body.JsonPayload.NextCursorPayload(
        id: "event-9",
        startTime: referenceDate
    )
    let cursor = EventPageCursor(payload)
    #expect(cursor.id == "event-9")
    #expect(cursor.startTime == referenceDate)
}

@Test func rsvpTargetMapsToGeneratedRequestStatus() {
    #expect(PulseRsvpTarget.going.generated == .going)
    #expect(PulseRsvpTarget.maybe.generated == .maybe)
    #expect(PulseRsvpTarget.notGoing.generated == .notGoing)
}

@Test func optimisticRsvpCarriesTargetStatusAndIds() {
    let rsvp = PulseRsvp(optimistic: .going, eventId: "event-1", profileId: "profile-1")
    #expect(rsvp.eventId == "event-1")
    #expect(rsvp.profileId == "profile-1")
    #expect(rsvp.status == .going)
}

@Test func pulseRsvpMapsGeneratedResponseFields() {
    let payload = Operations.RsvpToEvent.Output.Ok.Body.JsonPayload.RsvpPayload(
        createdAt: referenceDate,
        eventId: "event-1",
        id: "rsvp-1",
        profileId: "profile-1",
        status: .maybe
    )
    let rsvp = PulseRsvp(payload)
    #expect(rsvp.id == "rsvp-1")
    #expect(rsvp.eventId == "event-1")
    #expect(rsvp.profileId == "profile-1")
    #expect(rsvp.status == .maybe)
    #expect(rsvp.createdAt == referenceDate)
}

@Test func pulseRsvpCountsRoundsGeneratedDoublesToNearestInt() {
    let payload = Operations.GetEventRsvpCounts.Output.Ok.Body.JsonPayload.CountsPayload(
        going: 3.4,
        invited: 1.5,
        maybe: 2.6,
        notGoing: 0
    )
    let counts = PulseRsvpCounts(payload)
    #expect(counts.going == 3)
    #expect(counts.maybe == 3)
    #expect(counts.notGoing == 0)
    #expect(counts.invited == 2)
}
