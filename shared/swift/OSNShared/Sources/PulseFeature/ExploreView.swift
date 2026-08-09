import OSNUI
import SwiftUI

/// Explore tab: a paginated `discoverEvents` list. Real loading/empty/error
/// states only — no placeholder or mock rows.
public struct ExploreView: View {
    @State private var viewModel: ExploreViewModel

    private let session: PulseSession

    public init(session: PulseSession) {
        self.session = session
        _viewModel = State(wrappedValue: ExploreViewModel(api: session.api))
    }

    public var body: some View {
        Group {
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
                        "No events yet",
                        systemImage: "calendar"
                    )
                }
            } else {
                list
            }
        }
        .navigationTitle("Explore")
        .task {
            if viewModel.events.isEmpty {
                await viewModel.loadFirstPage()
            }
        }
    }

    private var list: some View {
        ScrollView {
            GlassEffectContainer {
                LazyVStack(spacing: 16) {
                    ForEach(viewModel.events) { event in
                        NavigationLink(value: event.id) {
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
        .navigationDestination(for: String.self) { eventId in
            EventDetailView(session: session, eventId: eventId)
        }
        .refreshable {
            await viewModel.loadFirstPage()
        }
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
