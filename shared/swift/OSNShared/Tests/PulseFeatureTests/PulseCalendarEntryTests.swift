import Foundation
import Testing
@testable import PulseAPI
@testable import PulseFeature

private typealias EntryPayload = Operations.ListMyCalendarEvents.Output.Ok.Body.JsonPayload
    .EntriesPayloadPayload

/// 2023-11-14 22:13:20 UTC.
private let lateUTCEvening = Date(timeIntervalSince1970: 1_700_000_000)

/// Sydney is UTC+11 in November, so its midnight falls at 13:00 UTC. These two
/// instants straddle it: one UTC day, two Sydney days.
private let beforeSydneyMidnight = Date(timeIntervalSince1970: 1_699_965_000)  // 12:30 UTC
private let afterSydneyMidnight = Date(timeIntervalSince1970: 1_699_968_600)  // 13:30 UTC

private func makeEventPayload(
    id: String,
    startTime: Date
) -> Components.Schemas.Event {
    .init(
        allowInterested: true,
        commsChannels: "email",
        createdAt: lateUTCEvening,
        createdByProfileId: "profile-1",
        guestListVisibility: .connections,
        id: id,
        instanceOverride: false,
        joinPolicy: .open,
        startTime: startTime,
        status: .upcoming,
        title: "Event \(id)",
        updatedAt: lateUTCEvening,
        visibility: ._public
    )
}

private func makeEntryPayload(
    id: String,
    startTime: Date = lateUTCEvening,
    myStatus: EntryPayload.MyStatusPayload? = nil,
    isHost: Bool = false
) -> EntryPayload {
    .init(
        event: makeEventPayload(id: id, startTime: startTime),
        isHost: isHost,
        myStatus: myStatus
    )
}

private func makeEntry(
    id: String,
    startTime: Date = lateUTCEvening,
    myStatus: PulseCalendarEntry.Attendance? = nil,
    isHost: Bool = false
) -> PulseCalendarEntry {
    PulseCalendarEntry(
        event: PulseEvent(makeEventPayload(id: id, startTime: startTime)),
        myStatus: myStatus,
        isHost: isHost
    )
}

private func calendar(timeZone identifier: String) -> Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: identifier)!
    return calendar
}

@Suite("PulseCalendarEntry")
struct PulseCalendarEntryTests {
    @Test("maps an attending guest's payload")
    func mapsAttendingGuest() {
        let entry = PulseCalendarEntry(makeEntryPayload(id: "event-1", myStatus: .going))

        #expect(entry.id == "event-1")
        #expect(entry.event.id == "event-1")
        #expect(entry.myStatus == .going)
        #expect(entry.isHost == false)
    }

    @Test("maps maybe")
    func mapsMaybe() {
        #expect(PulseCalendarEntry(makeEntryPayload(id: "event-1", myStatus: .maybe)).myStatus == .maybe)
    }

    /// The usual organiser row: hosting is the whole reason it is on the
    /// agenda, and there is no RSVP behind it.
    @Test("a host with no RSVP maps to a nil status, not a default one")
    func mapsHostWithoutRsvp() {
        let entry = PulseCalendarEntry(makeEntryPayload(id: "event-1", myStatus: nil, isHost: true))

        #expect(entry.myStatus == nil)
        #expect(entry.isHost)
    }

    /// The server merges the hosted and attending arms by event id, so both
    /// facts can be true of one row. Neither may swallow the other.
    @Test("a host who also RSVP'd keeps both facts")
    func mapsHostWhoAlsoRsvpd() {
        let entry = PulseCalendarEntry(makeEntryPayload(id: "event-1", myStatus: .going, isHost: true))

        #expect(entry.myStatus == .going)
        #expect(entry.isHost)
    }
}

@Suite("PulseCalendarEntry.groupedByDay")
struct PulseCalendarGroupingTests {
    @Test("an empty agenda groups into no days")
    func groupsEmpty() {
        #expect([PulseCalendarEntry]().groupedByDay(calendar: calendar(timeZone: "UTC")).isEmpty)
    }

    @Test("consecutive entries on one day land in one group, in server order")
    func groupsOneDay() {
        let entries = [
            makeEntry(id: "event-1", startTime: lateUTCEvening),
            makeEntry(id: "event-2", startTime: lateUTCEvening.addingTimeInterval(600)),
        ]

        let days = entries.groupedByDay(calendar: calendar(timeZone: "UTC"))

        #expect(days.count == 1)
        #expect(days[0].entries.map(\.id) == ["event-1", "event-2"])
    }

    @Test("entries on different days split into separate groups, in order")
    func groupsAcrossDays() {
        let entries = [
            makeEntry(id: "event-1", startTime: lateUTCEvening),
            makeEntry(id: "event-2", startTime: lateUTCEvening.addingTimeInterval(86_400)),
            makeEntry(id: "event-3", startTime: lateUTCEvening.addingTimeInterval(86_400 + 60)),
        ]

        let days = entries.groupedByDay(calendar: calendar(timeZone: "UTC"))

        #expect(days.count == 2)
        #expect(days[0].entries.map(\.id) == ["event-1"])
        #expect(days[1].entries.map(\.id) == ["event-2", "event-3"])
        #expect(days[0].date < days[1].date)
    }

    /// The grouping calendar decides what "a day" is. The same two instants
    /// are one UTC evening and two Sydney days, so a viewer in Sydney must see
    /// the split — which is why the calendar is injected rather than read from
    /// the environment inside the loop.
    @Test("the injected calendar's time zone decides the day boundary")
    func groupsByInjectedTimeZone() {
        let entries = [
            makeEntry(id: "event-1", startTime: beforeSydneyMidnight),
            makeEntry(id: "event-2", startTime: afterSydneyMidnight),
        ]

        #expect(entries.groupedByDay(calendar: calendar(timeZone: "UTC")).count == 1)
        #expect(entries.groupedByDay(calendar: calendar(timeZone: "Australia/Sydney")).count == 2)
    }

    /// The single pass only merges *adjacent* entries. The server sorts by
    /// `(startTime, id)` so same-day rows always arrive adjacent — this pins
    /// what happens if that ever stops being true, so the behaviour is a
    /// recorded consequence rather than a surprise.
    @Test("a day that recurs after another day opens a second group")
    func doesNotMergeNonAdjacentDays() {
        let entries = [
            makeEntry(id: "event-1", startTime: lateUTCEvening),
            makeEntry(id: "event-2", startTime: lateUTCEvening.addingTimeInterval(86_400)),
            makeEntry(id: "event-3", startTime: lateUTCEvening.addingTimeInterval(60)),
        ]

        let days = entries.groupedByDay(calendar: calendar(timeZone: "UTC"))

        #expect(days.count == 3)
        #expect(days[0].date == days[2].date)
    }

    @Test("a day's id is its start-of-day date")
    func dayIdIsItsDate() {
        let utc = calendar(timeZone: "UTC")
        let days = [makeEntry(id: "event-1")].groupedByDay(calendar: utc)

        #expect(days[0].id == days[0].date)
        #expect(days[0].date == utc.startOfDay(for: lateUTCEvening))
    }
}
