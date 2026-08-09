import Foundation
import Observation
import PulseAPI

/// Drives the Explore screen: loads `discoverEvents` pages and holds the
/// accumulated list plus load state. Owns no `URLSession`/token — it only
/// ever calls through the `APIProtocol` client `PulseSession` builds via
/// `makePulseClient`.
@MainActor
@Observable
public final class ExploreViewModel {
    public enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    public private(set) var events: [PulseEvent] = []
    public private(set) var state: LoadState = .idle
    public private(set) var hasMore = true

    private let api: any APIProtocol
    private let pageSize: Int

    public init(api: any APIProtocol, pageSize: Int = 20) {
        self.api = api
        self.pageSize = pageSize
    }

    public func loadFirstPage() async {
        events = []
        hasMore = true
        await load(cursor: nil)
    }

    /// Call when a row is about to appear — triggers the next page once the
    /// last loaded row is reached.
    public func loadNextPageIfNeeded(currentItemId: String) async {
        guard hasMore, state != .loading, events.last?.id == currentItemId else { return }
        await load(cursor: events.keysetCursor)
    }

    private func load(cursor: EventPageCursor?) async {
        state = .loading
        do {
            let query = Operations.DiscoverEvents.Input.Query(
                cursorStartTime: cursor?.startTime,
                cursorId: cursor?.id,
                limit: .init(value2: Double(pageSize))
            )
            let output = try await api.discoverEvents(.init(query: query))
            let page = try output.ok.body.json.events.map(PulseEvent.init)
            if cursor == nil {
                events = page
            } else {
                events.append(contentsOf: page)
            }
            hasMore = page.count == pageSize
            state = .loaded
        } catch {
            state = .failed(String(describing: error))
        }
    }
}
