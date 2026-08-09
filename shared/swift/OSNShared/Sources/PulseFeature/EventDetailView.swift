import MapKit
import OSNUI
import SwiftUI

/// Event detail + RSVP screen. Renders every field `eventResponseSchema`
/// carries that means something to a guest: what it is, when, where, what it
/// costs, who is hosting, and — for a cancelled event — why.
///
/// "Add to Calendar" hands over an `.ics` document rather than writing to the
/// calendar directly; see `PulseCalendarInvite` for why.
///
/// There is no share button. The web one builds its URL from
/// `window.location.origin`, and no Pulse web host is deployed for iOS to
/// name in its place.
public struct EventDetailView: View {
    @State private var viewModel: EventDetailViewModel
    /// The `.ics` written to a temporary file so `ShareLink` has something to
    /// hand to Calendar. Nil until the event has loaded and the write lands.
    @State private var calendarFile: URL?

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
                    header(for: event)
                    if let host = event.createdByName {
                        hostRow(name: host, avatar: event.createdByAvatar)
                    }
                    if let description = event.description, !description.isEmpty {
                        GlassCard {
                            Text(description)
                                .font(.osn(.body, size: 16))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    place(for: event)
                    if let counts = viewModel.counts {
                        GlassCard {
                            HStack(spacing: 16) {
                                countLabel("Going", counts.going)
                                countLabel("Maybe", counts.maybe)
                                countLabel("Can't go", counts.notGoing)
                            }
                        }
                    }
                    if let calendarFile {
                        ShareLink(item: calendarFile) {
                            Label("Add to Calendar", systemImage: "calendar.badge.plus")
                                .font(.osn(.body, size: 16))
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
        // Keyed on the id so opening a second event replaces the first
        // event's file rather than offering it again.
        .task(id: event.id) {
            calendarFile = await writeCalendarFile(for: event)
        }
    }

    @ViewBuilder
    private func header(for event: PulseEvent) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                Text(event.title)
                    .font(.osn(.display, size: 28))
                HStack(spacing: 8) {
                    if event.status == .cancelled {
                        Pill("Cancelled", tint: .red)
                    } else if event.status == .ongoing {
                        LiveBadge()
                    }
                    if let category = event.category, !category.isEmpty {
                        Pill(category, tint: OSNColor.accent)
                    }
                    Pill(priceLabel(for: event), tint: OSNColor.accentStrong)
                }
                schedule(for: event)
                    .font(.osn(.body, size: 14))
                if let reason = event.cancellationReason {
                    Text(cancellationText(reason))
                        .font(.osn(.body, size: 14))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// A start and an end read as a range; a start on its own is stated on its
    /// own, because the server genuinely does not know when some events
    /// finish and a guessed duration would be worse than none.
    @ViewBuilder
    private func schedule(for event: PulseEvent) -> some View {
        if let endTime = event.endTime, endTime > event.startTime {
            Text(event.startTime...endTime)
        } else {
            Text(event.startTime, format: .dateTime.weekday(.wide).day().month(.wide).hour().minute())
        }
    }

    @ViewBuilder
    private func hostRow(name: String, avatar: String?) -> some View {
        HStack(spacing: 8) {
            AvatarView {
                AsyncImage(url: avatar.flatMap(URL.init(string:))) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Circle().fill(OSNColor.accentSoft)
                }
            }
            .frame(width: 36, height: 36)
            Text("Hosted by \(name)")
                .font(.osn(.body, size: 14))
        }
    }

    /// Address text and map are separate: an event can carry either without
    /// the other, and a pin with no name is as useful as a name with no pin.
    @ViewBuilder
    private func place(for event: PulseEvent) -> some View {
        if event.venue != nil || event.location != nil || event.coordinate != nil {
            GlassCard {
                VStack(alignment: .leading, spacing: 8) {
                    if let venue = event.venue, !venue.isEmpty {
                        Text(venue)
                            .font(.osn(.body, size: 16))
                    }
                    if let location = event.location, !location.isEmpty {
                        Text(location)
                            .font(.osn(.body, size: 14))
                            .foregroundStyle(.secondary)
                    }
                    if let coordinate = event.coordinate {
                        // A still picture of where it is, not a second map to
                        // pan — Explore owns that job.
                        Map(
                            initialPosition: .region(
                                MKCoordinateRegion(
                                    center: CLLocationCoordinate2D(
                                        latitude: coordinate.latitude,
                                        longitude: coordinate.longitude
                                    ),
                                    span: MKCoordinateSpan(latitudeDelta: 0.01, longitudeDelta: 0.01)
                                )
                            ),
                            interactionModes: []
                        ) {
                            Marker(
                                event.title,
                                coordinate: CLLocationCoordinate2D(
                                    latitude: coordinate.latitude,
                                    longitude: coordinate.longitude
                                )
                            )
                            .tint(OSNColor.accent)
                        }
                        .frame(height: 160)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
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

    private func priceLabel(for event: PulseEvent) -> String {
        guard let price = event.price, !price.isFree else { return "Free" }
        return price.formatted()
    }

    /// `hostLeft` is worded for a guest, who did not lose an account and only
    /// needs to know the event is off and nobody is running it.
    private func cancellationText(_ reason: PulseEvent.CancellationReason) -> String {
        switch reason {
        case .hostLeft: "Cancelled — the host is no longer on Pulse."
        case .organiser: "Cancelled by the host."
        case .admin: "Cancelled by Pulse."
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

/// Writes the event's `.ics` to a temporary file and returns its URL.
///
/// `ShareLink` needs a file on disk to give Calendar a document rather than a
/// wall of text. Nonisolated, so the write runs off the main actor; a failure
/// returns nil and the button simply doesn't appear, which is better than a
/// button that shares nothing.
private func writeCalendarFile(for event: PulseEvent) async -> URL? {
    let invite = PulseCalendarInvite(event: event)
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(invite.filename)
    do {
        try invite.text.write(to: url, atomically: true, encoding: .utf8)
        return url
    } catch {
        return nil
    }
}
