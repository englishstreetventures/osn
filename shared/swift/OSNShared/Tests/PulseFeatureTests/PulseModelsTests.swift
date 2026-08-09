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

@Test func keysetCursorIsNilForEmptyPage() {
    let events: [PulseEvent] = []
    #expect(events.keysetCursor == nil)
}

@Test func keysetCursorEchoesLastEventsStartTimeAndId() {
    let events = [PulseEvent(makeDiscoverEventsPayload(id: "a")), PulseEvent(makeDiscoverEventsPayload(id: "b"))]
    let cursor = events.keysetCursor
    #expect(cursor?.id == "b")
    #expect(cursor?.startTime == referenceDate)
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
