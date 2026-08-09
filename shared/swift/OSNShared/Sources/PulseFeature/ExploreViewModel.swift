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

    /// The map viewport the search is pinned to, or `nil` for "everywhere".
    /// Set by the map, read by the map's own framing — never guessed from the
    /// device, which has no location permission to guess with.
    public private(set) var region: PulseSearchRegion?

    /// Whether another page exists. The server says so directly — a null
    /// `nextCursor` is the end of the list — so this no longer guesses from
    /// a full-looking page, which always cost one extra empty request when
    /// the last page happened to be exactly `pageSize` long.
    public var hasMore: Bool { !hasLoaded || nextCursor != nil }

    private let api: any APIProtocol
    private let pageSize: Int
    private var nextCursor: EventPageCursor?
    private var hasLoaded = false
    private var loadGeneration = 0

    public init(api: any APIProtocol, pageSize: Int = 20) {
        self.api = api
        self.pageSize = pageSize
    }

    public func loadFirstPage() async {
        events = []
        nextCursor = nil
        hasLoaded = false
        await load(cursor: nil)
    }

    /// Point the search at a map viewport and reload from the first page.
    ///
    /// A pan or zoom too small to change the answer is ignored — see
    /// `PulseSearchRegion.isMeaningfullyDifferent(from:)`. Without that, every
    /// settled gesture would cost a page of the same events.
    public func updateRegion(_ newRegion: PulseSearchRegion) async {
        if let region, !newRegion.isMeaningfullyDifferent(from: region) { return }
        region = newRegion
        await loadFirstPage()
    }

    /// Drop the map filter and search everywhere again.
    public func clearRegion() async {
        guard region != nil else { return }
        region = nil
        await loadFirstPage()
    }

    /// Call when a row is about to appear — triggers the next page once the
    /// last loaded row is reached.
    public func loadNextPageIfNeeded(currentItemId: String) async {
        guard let cursor = nextCursor, state != .loading, events.last?.id == currentItemId else { return }
        await load(cursor: cursor)
    }

    private func load(cursor: EventPageCursor?) async {
        loadGeneration += 1
        let generation = loadGeneration
        state = .loading
        do {
            let query = Operations.DiscoverEvents.Input.Query(
                lat: region.map { .init(value2: $0.center.latitude) },
                lng: region.map { .init(value2: $0.center.longitude) },
                radiusKm: region.map { .init(value2: $0.radiusKm) },
                cursorStartTime: cursor?.startTime,
                cursorId: cursor?.id,
                limit: .init(value2: Double(pageSize))
            )
            let output = try await api.discoverEvents(.init(query: query))
            let body = try output.ok.body.json
            // A pan that lands mid-request starts a newer load; that one owns
            // the list from here, so this reply is stale and gets dropped
            // rather than appended out of order.
            guard generation == loadGeneration else { return }
            let page = body.events.map(PulseEvent.init)
            if cursor == nil {
                events = page
            } else {
                events.append(contentsOf: page)
            }
            nextCursor = body.nextCursor.map(EventPageCursor.init)
            hasLoaded = true
            state = .loaded
        } catch {
            // The map cancels the in-flight search when the user keeps
            // panning. That is the feature working, not a failure to show.
            guard !Task.isCancelled, generation == loadGeneration else { return }
            state = .failed(String(describing: error))
        }
    }
}
