import OSNUI
import SwiftUI

/// Calendar tab: the signed-in viewer's own agenda — events they host and
/// events they said `going`/`maybe` to — grouped by day, soonest first.
///
/// This is not the Explore feed narrowed down. Explore asks "what is on?";
/// this asks "what am I doing?", so it shows cancelled events the viewer is
/// still on the list for and never shows an event they have no tie to.
public struct CalendarView: View {
    @State private var viewModel: CalendarViewModel
    @State private var selectedEventId: String?

    private let session: PulseSession

    public init(session: PulseSession) {
        self.session = session
        _viewModel = State(wrappedValue: CalendarViewModel(api: session.api))
    }

    public var body: some View {
        content
            .navigationTitle("Calendar")
            .navigationDestination(item: $selectedEventId) { eventId in
                EventDetailView(session: session, eventId: eventId)
            }
            .task {
                if viewModel.isEmpty {
                    await viewModel.load()
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isEmpty {
            switch viewModel.state {
            case .idle, .loading:
                ProgressView()
            case .failed(let message):
                ContentUnavailableView(
                    "Couldn't load your calendar",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
            case .loaded:
                ContentUnavailableView(
                    "Nothing on yet",
                    systemImage: "calendar",
                    description: Text("Events you host or RSVP to show up here.")
                )
            }
        } else {
            agenda
        }
    }

    private var agenda: some View {
        ScrollView {
            GlassEffectContainer {
                LazyVStack(alignment: .leading, spacing: 24, pinnedViews: .sectionHeaders) {
                    ForEach(viewModel.days) { day in
                        Section {
                            VStack(spacing: 16) {
                                ForEach(day.entries) { entry in
                                    Button {
                                        selectedEventId = entry.id
                                    } label: {
                                        CalendarRow(entry: entry)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        } header: {
                            DayHeader(date: day.date)
                        }
                    }
                }
                .padding()
            }
        }
        .refreshable {
            await viewModel.load()
        }
    }
}

/// Sticky day heading. `.date` formatting is left to the system so the
/// viewer's own locale and calendar decide what a day is called.
private struct DayHeader: View {
    let date: Date

    var body: some View {
        HStack {
            Text(date, format: .dateTime.weekday(.wide).day().month(.wide))
                .font(.osn(.body, size: 16))
            Spacer()
        }
        .padding(.vertical, 4)
        .background(.bar)
    }
}

private struct CalendarRow: View {
    let entry: PulseCalendarEntry

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(entry.event.title)
                        .font(.osn(.body, size: 18))
                    Spacer()
                    if entry.event.status == .ongoing {
                        LiveBadge()
                    }
                }
                HStack(spacing: 8) {
                    // Hosting and attending are separate facts, so an
                    // organiser who also RSVP'd shows both rather than one
                    // pill overwriting the other.
                    if entry.isHost {
                        Pill("Hosting", tint: OSNColor.accent)
                    }
                    if let myStatus = entry.myStatus {
                        Pill(myStatus.rawValue, tint: OSNColor.accent)
                    }
                    // A cancelled event stays on the agenda — the viewer
                    // planned around it and needs to see that it is off.
                    if entry.event.status == .cancelled {
                        Pill("Cancelled", tint: OSNColor.accent)
                    }
                }
                Text(entry.event.startTime, style: .time)
                    .font(.osn(.body, size: 14))
            }
        }
    }
}
