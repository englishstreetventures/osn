import Foundation
import Observation
import PulseAPI

/// Drives the Event detail screen: loads an event + its RSVP counts, and
/// submits RSVPs with an optimistic update that rolls back on failure.
@MainActor
@Observable
public final class EventDetailViewModel {
    public enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    public private(set) var event: PulseEvent?
    public private(set) var counts: PulseRsvpCounts?
    public private(set) var myRsvp: PulseRsvp?
    public private(set) var state: LoadState = .idle
    public private(set) var rsvpError: String?

    private let api: any APIProtocol
    private let eventId: String
    private let profileId: String

    public init(api: any APIProtocol, eventId: String, profileId: String) {
        self.api = api
        self.eventId = eventId
        self.profileId = profileId
    }

    public func load() async {
        state = .loading
        do {
            async let eventOutput = api.getEventById(.init(path: .init(id: eventId)))
            async let countsOutput = api.getEventRsvpCounts(.init(path: .init(id: eventId)))
            event = PulseEvent(try await eventOutput.ok.body.json.event)
            counts = PulseRsvpCounts(try await countsOutput.ok.body.json.counts)
            state = .loaded
        } catch {
            state = .failed(String(describing: error))
        }
    }

    /// Applies `target` optimistically, then confirms against the server
    /// response. Rolls back to the prior `myRsvp` (and prior counts) on
    /// failure rather than leaving the optimistic guess in place.
    public func rsvp(_ target: PulseRsvpTarget) async {
        let previousRsvp = myRsvp
        let previousCounts = counts
        rsvpError = nil
        myRsvp = PulseRsvp(optimistic: target, eventId: eventId, profileId: profileId)
        do {
            let body = Operations.RsvpToEvent.Input.Body.json(.init(status: target.generated))
            let output = try await api.rsvpToEvent(.init(path: .init(id: eventId), body: body))
            myRsvp = PulseRsvp(try output.ok.body.json.rsvp)
            let countsOutput = try await api.getEventRsvpCounts(.init(path: .init(id: eventId)))
            counts = PulseRsvpCounts(try countsOutput.ok.body.json.counts)
        } catch {
            myRsvp = previousRsvp
            counts = previousCounts
            rsvpError = String(describing: error)
        }
    }
}
