import MapKit
import OSNUI
import SwiftUI

/// Explore tab: a paginated `discoverEvents` list, or the same search drawn
/// on a map. Real loading/empty/error states only — no placeholder or mock
/// rows.
public struct ExploreView: View {
    private enum Mode: String, CaseIterable, Identifiable {
        case list = "List"
        case map = "Map"

        var id: Self { self }
        var symbol: String { self == .list ? "list.bullet" : "map" }
    }

    @State private var viewModel: ExploreViewModel
    @State private var mode: Mode = .list
    /// Drives both the map's pin selection and a row tap, so the two modes
    /// push the same detail screen through one destination.
    @State private var selectedEventId: String?

    private let session: PulseSession

    public init(session: PulseSession) {
        self.session = session
        _viewModel = State(wrappedValue: ExploreViewModel(api: session.api))
    }

    public var body: some View {
        Group {
            switch mode {
            case .list:
                listMode
            case .map:
                ExploreMap(
                    events: viewModel.events,
                    selectedEventId: $selectedEventId,
                    onRegionChange: { await viewModel.updateRegion($0) }
                )
            }
        }
        .navigationTitle("Explore")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Picker("View", selection: $mode) {
                    ForEach(Mode.allCases) { mode in
                        Label(mode.rawValue, systemImage: mode.symbol).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
            }
        }
        .navigationDestination(item: $selectedEventId) { eventId in
            EventDetailView(session: session, eventId: eventId)
        }
        .task {
            if viewModel.events.isEmpty {
                await viewModel.loadFirstPage()
            }
        }
    }

    @ViewBuilder
    private var listMode: some View {
        if viewModel.events.isEmpty {
            switch viewModel.state {
            case .idle, .loading:
                ProgressView()
            case .failed(let message):
                ContentUnavailableView(
                    "Couldn't load events",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
            case .loaded:
                ContentUnavailableView(
                    viewModel.region == nil ? "No events yet" : "No events in this area",
                    systemImage: "calendar",
                    description: viewModel.region == nil ? nil : Text("Move the map or search everywhere.")
                )
            }
        } else {
            list
        }
    }

    private var list: some View {
        ScrollView {
            GlassEffectContainer {
                LazyVStack(spacing: 16) {
                    // The list inherits whatever area the map was last left
                    // on. Say so, and offer the way out — otherwise a short
                    // list after a zoom reads as "there is nothing on".
                    if viewModel.region != nil {
                        GlassButton("Searching this map area — search everywhere", kind: .secondary) {
                            Task { await viewModel.clearRegion() }
                        }
                    }
                    ForEach(viewModel.events) { event in
                        Button {
                            selectedEventId = event.id
                        } label: {
                            EventRow(event: event)
                        }
                        .buttonStyle(.plain)
                        .task {
                            await viewModel.loadNextPageIfNeeded(currentItemId: event.id)
                        }
                    }
                }
                .padding()
            }
        }
        .refreshable {
            await viewModel.loadFirstPage()
        }
    }
}

/// The same `discoverEvents` search, drawn where the events are.
///
/// The visible viewport *is* the query: pan or zoom, and the map's centre and
/// corner distance become `lat`/`lng`/`radiusKm`. Nothing asks the device
/// where it is.
private struct ExploreMap: View {
    let events: [PulseEvent]
    @Binding var selectedEventId: String?
    let onRegionChange: (PulseSearchRegion) async -> Void

    /// Starts at `.automatic`, which frames whatever pins the first
    /// unfiltered page produced. That framing is not a user's choice of area,
    /// so it deliberately does not trigger a search — see the guard below.
    @State private var position: MapCameraPosition = .automatic
    @State private var pendingRegion: PulseSearchRegion?

    /// Only events the server gave coordinates for can be drawn. The rest are
    /// still in the list; a pin at a made-up point would be worse than none.
    private var mappable: [PulseEvent] {
        events.filter { $0.coordinate != nil }
    }

    var body: some View {
        Map(position: $position, selection: $selectedEventId) {
            ForEach(mappable) { event in
                if let coordinate = event.coordinate {
                    Marker(
                        event.title,
                        systemImage: event.status == .ongoing ? "dot.radiowaves.left.and.right" : "sparkles",
                        coordinate: CLLocationCoordinate2D(
                            latitude: coordinate.latitude,
                            longitude: coordinate.longitude
                        )
                    )
                    .tint(OSNColor.accent)
                    .tag(event.id)
                }
            }
        }
        .onMapCameraChange(frequency: .onEnd) { context in
            // `.automatic` frames the pins itself, and those pins came from
            // the last search. Querying that frame would feed a search its own
            // output and never settle, so only a camera the user placed counts.
            guard position.positionedByUser else { return }
            pendingRegion = PulseSearchRegion(context.region)
        }
        // Keyed on the region so a gesture that lands mid-request cancels the
        // request it superseded instead of racing it.
        .task(id: pendingRegion) {
            guard let pendingRegion else { return }
            await onRegionChange(pendingRegion)
        }
        .ignoresSafeArea(edges: .bottom)
    }
}

private struct EventRow: View {
    let event: PulseEvent

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(event.title)
                        .font(.osn(.body, size: 18))
                    Spacer()
                    if event.status == .ongoing {
                        LiveBadge()
                    }
                }
                Pill(event.status.rawValue, tint: OSNColor.accent)
                Text(event.startTime, style: .date)
                    .font(.osn(.body, size: 14))
            }
        }
    }
}
