import Foundation
import Observation
import PulseAPI

/// Drives the Calendar tab: loads the signed-in viewer's agenda and holds the
/// day-grouped list plus load state. Like `ExploreViewModel` it owns no
/// `URLSession` and no token — it only calls through the `APIProtocol` client
/// `PulseSession` builds.
///
/// There is no pagination here because the endpoint has none: the agenda is a
/// single forward-looking window the server caps at 100 rows. `limit` is the
/// only knob, and it is a string on the wire — the route parses it and clamps
/// it, so a value outside 1...100 is silently corrected rather than rejected.
@MainActor
@Observable
public final class CalendarViewModel {
    public enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    /// The agenda grouped by start day, in server order. Computed once per
    /// load rather than on every render — the grouping is a full pass over the
    /// list and the list only changes when a load finishes.
    public private(set) var days: [PulseCalendarDay] = []
    public private(set) var state: LoadState = .idle

    /// True once the server has answered at least once, so an empty `days`
    /// can be told apart from "nothing loaded yet".
    public var isEmpty: Bool { days.isEmpty }

    private let api: any APIProtocol
    private let limit: Int
    private let calendar: Calendar
    private var loadGeneration = 0

    public init(api: any APIProtocol, limit: Int = 50, calendar: Calendar = .autoupdatingCurrent) {
        self.api = api
        self.limit = limit
        self.calendar = calendar
    }

    public func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        state = .loading
        do {
            let output = try await api.listMyCalendarEvents(
                .init(query: .init(limit: String(limit)))
            )
            let body = try output.ok.body.json
            // A pull-to-refresh landing mid-request starts a newer load; that
            // one owns the list from here, so this reply is dropped rather
            // than overwriting a fresher one.
            guard generation == loadGeneration else { return }
            days = body.entries.map(PulseCalendarEntry.init).groupedByDay(calendar: calendar)
            state = .loaded
        } catch {
            // A view that goes away cancels its load. That is the screen
            // closing, not a failure worth showing.
            guard !Task.isCancelled, generation == loadGeneration else { return }
            state = .failed(String(describing: error))
        }
    }
}
