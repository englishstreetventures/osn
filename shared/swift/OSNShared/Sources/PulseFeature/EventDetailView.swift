import OSNUI
import SwiftUI

/// Event detail + RSVP screen. Renders `status == .cancelled`; the real
/// generated schema has no `cancellationReason` field, so none is shown
/// (see `a5-notes.md`).
public struct EventDetailView: View {
    @State private var viewModel: EventDetailViewModel

    public init(session: PulseSession, eventId: String) {
        let profileId: String
        if case .signedIn(let profile?) = session.state {
            profileId = profile.id
        } else {
            profileId = ""
        }
        _viewModel = State(wrappedValue: EventDetailViewModel(api: session.api, eventId: eventId, profileId: profileId))
    }

    public var body: some View {
        Group {
            if let event = viewModel.event {
                detail(for: event)
            } else {
                switch viewModel.state {
                case .idle, .loading:
                    ProgressView()
                case .failed(let message):
                    ContentUnavailableView(
                        "Couldn't load event",
                        systemImage: "exclamationmark.triangle",
                        description: Text(message)
                    )
                case .loaded:
                    ContentUnavailableView("Event not found", systemImage: "calendar")
                }
            }
        }
        .task {
            if viewModel.event == nil {
                await viewModel.load()
            }
        }
    }

    @ViewBuilder
    private func detail(for event: PulseEvent) -> some View {
        ScrollView {
            GlassEffectContainer {
                VStack(alignment: .leading, spacing: 16) {
                    GlassCard {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(event.title)
                                .font(.osn(.display, size: 28))
                            if event.status == .cancelled {
                                Pill("Cancelled", tint: .red)
                            } else if event.status == .ongoing {
                                LiveBadge()
                            }
                            Text(event.startTime, style: .date)
                                .font(.osn(.body, size: 14))
                        }
                    }

                    if let counts = viewModel.counts {
                        GlassCard {
                            HStack(spacing: 16) {
                                countLabel("Going", counts.going)
                                countLabel("Maybe", counts.maybe)
                                countLabel("Can't go", counts.notGoing)
                            }
                        }
                    }

                    if let error = viewModel.rsvpError {
                        Text(error)
                            .font(.osn(.body, size: 14))
                            .foregroundStyle(.red)
                    }

                    if event.status != .cancelled {
                        rsvpButtons
                    }
                }
                .padding()
            }
        }
        .navigationTitle(event.title)
    }

    private var rsvpButtons: some View {
        HStack(spacing: 12) {
            ForEach(PulseRsvpTarget.allCases, id: \.self) { target in
                GlassButton(
                    title(for: target),
                    kind: viewModel.myRsvp?.status == PulseRsvp.Status(target) ? .primary : .secondary
                ) {
                    Task { await viewModel.rsvp(target) }
                }
            }
        }
    }

    private func title(for target: PulseRsvpTarget) -> String {
        switch target {
        case .going: "Going"
        case .maybe: "Maybe"
        case .notGoing: "Can't go"
        }
    }

    private func countLabel(_ title: String, _ value: Int) -> some View {
        VStack {
            Text("\(value)")
                .font(.osn(.body, size: 20))
            Text(title)
                .font(.osn(.body, size: 12))
        }
    }
}
