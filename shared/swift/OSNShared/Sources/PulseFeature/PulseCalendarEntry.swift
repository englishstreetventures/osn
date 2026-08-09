import Foundation
import PulseAPI

/// One row of the signed-in viewer's agenda.
///
/// The server builds this list from two arms — events the viewer created and
/// events they RSVP'd `going`/`maybe` to — and merges them by event id, so a
/// host who also RSVP'd to their own event appears once with both facts set.
/// Neither flag implies the other: `isHost` with no `myStatus` is the usual
/// organiser row, and `myStatus` with `isHost == false` is an ordinary guest.
public struct PulseCalendarEntry: Identifiable, Equatable, Sendable {
    /// The viewer's own RSVP, narrowed to the two states that put an event on
    /// a calendar. `not_going` and `invited` are real RSVP statuses but the
    /// agenda query excludes them, so they are unrepresentable here rather
    /// than being cases nothing can produce.
    public enum Attendance: String, Equatable, Sendable {
        case going
        case maybe
    }

    public let event: PulseEvent
    /// `nil` when the viewer has not RSVP'd — including the common case of an
    /// organiser who never RSVP'd to their own event.
    public let myStatus: Attendance?
    public let isHost: Bool

    public var id: String { event.id }

    public init(event: PulseEvent, myStatus: Attendance?, isHost: Bool) {
        self.event = event
        self.myStatus = myStatus
        self.isHost = isHost
    }
}

extension PulseCalendarEntry.Attendance {
    init(_ generated: Operations.ListMyCalendarEvents.Output.Ok.Body.JsonPayload.EntriesPayloadPayload.MyStatusPayload) {
        switch generated {
        case .going: self = .going
        case .maybe: self = .maybe
        }
    }
}

extension PulseCalendarEntry {
    public init(_ payload: Operations.ListMyCalendarEvents.Output.Ok.Body.JsonPayload.EntriesPayloadPayload) {
        self.init(
            event: PulseEvent(payload.event),
            myStatus: payload.myStatus.map(Attendance.init),
            isHost: payload.isHost
        )
    }
}

/// A day's worth of agenda rows, in the order the server returned them.
///
/// The calendar is a list of days rather than a flat list because "when" is
/// the only thing a viewer scans an agenda for. `date` is the start of the
/// day in the grouping calendar, so it is safe to compare and to format as a
/// header; the entries keep the server's sort.
public struct PulseCalendarDay: Identifiable, Equatable, Sendable {
    public let date: Date
    public let entries: [PulseCalendarEntry]

    public var id: Date { date }

    public init(date: Date, entries: [PulseCalendarEntry]) {
        self.date = date
        self.entries = entries
    }
}

extension Array where Element == PulseCalendarEntry {
    /// Group the agenda into days by each event's **start** time.
    ///
    /// The calendar is passed in rather than read from the environment inside
    /// the loop: which day an 11pm event falls on depends on the time zone,
    /// and a test that could not fix the zone would pass or fail by where the
    /// machine running it happens to be.
    ///
    /// The server already sorts by `(startTime, id)`, so a single pass keeps
    /// both the days and the rows inside each day in that order — no re-sort,
    /// and no dictionary to shuffle them.
    public func groupedByDay(calendar: Calendar = .autoupdatingCurrent) -> [PulseCalendarDay] {
        var days: [PulseCalendarDay] = []
        for entry in self {
            let day = calendar.startOfDay(for: entry.event.startTime)
            if let last = days.last, last.date == day {
                days[days.count - 1] = PulseCalendarDay(date: day, entries: last.entries + [entry])
            } else {
                days.append(PulseCalendarDay(date: day, entries: [entry]))
            }
        }
        return days
    }
}
