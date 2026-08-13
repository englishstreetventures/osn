import OSNAuth
import OSNUI
import SwiftUI

/// Security screen: everything that happened to the account and hasn't been
/// looked at, plus the recovery codes that get the user back in when the
/// passkey is gone.
///
/// The feed is unacknowledged-only, so an empty screen is the good outcome
/// and says so. Acknowledging runs a passkey ceremony — the point of the
/// gate is that an attacker holding a stolen access token cannot quietly
/// clear the evidence of themselves.
public struct SecurityView: View {
    @State private var viewModel: SecurityViewModel

    public init(session: MusubiSession, anchorProvider: @escaping PresentationAnchorProvider) {
        _viewModel = State(
            wrappedValue: SecurityViewModel(api: session.makeSecurityAPI(anchorProvider: anchorProvider))
        )
    }

    /// For previews and for a caller that already has an API of its own.
    public init(viewModel: SecurityViewModel) {
        _viewModel = State(wrappedValue: viewModel)
    }

    public var body: some View {
        ScrollView {
            GlassEffectContainer {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if let mutationError = viewModel.mutationError {
                        Text(mutationError)
                            .font(.osn(.body, size: 14))
                            .foregroundStyle(.red)
                    }

                    RecoveryCard(
                        status: viewModel.recovery,
                        isGenerating: viewModel.isGenerating,
                        generate: { Task { await viewModel.generateRecoveryCodes() } }
                    )

                    feed
                }
                .padding()
            }
        }
        .navigationTitle("Security")
        .refreshable {
            await viewModel.load()
        }
        .task {
            if viewModel.state == .idle {
                await viewModel.load()
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Clear all") {
                    Task { await viewModel.acknowledgeAll() }
                }
                .disabled(viewModel.isEmpty || viewModel.isAcknowledgingAll)
            }
        }
        .sheet(isPresented: codesArePresented) {
            RecoveryCodesSheet(codes: viewModel.freshCodes ?? [])
        }
    }

    /// The sheet is driven off `freshCodes` and clears it on dismissal, so
    /// the plaintext lives exactly as long as the sheet does.
    private var codesArePresented: Binding<Bool> {
        Binding(
            get: { viewModel.freshCodes != nil },
            set: { if !$0 { viewModel.dismissCodes() } }
        )
    }

    @ViewBuilder
    private var feed: some View {
        switch viewModel.state {
        case .idle:
            ProgressView()
        // A reload with rows already on screen keeps them: the refresh
        // control is the progress indicator there.
        case .loading where viewModel.isEmpty:
            ProgressView()
        case .failed(let message):
            ContentUnavailableView(
                "Couldn't load your security events",
                systemImage: "exclamationmark.triangle",
                description: Text(message)
            )
        default:
            if viewModel.isEmpty {
                // Nothing to read is the good answer here, so it reads as
                // one rather than as an empty list.
                ContentUnavailableView(
                    "Nothing to review",
                    systemImage: "checkmark.shield",
                    description: Text("Anything worth knowing about your account shows up here.")
                )
            } else {
                ForEach(viewModel.events) { event in
                    SecurityEventRow(
                        event: event,
                        isAcknowledging: viewModel.acknowledgingID == event.id,
                        acknowledge: { Task { await viewModel.acknowledge(id: event.id) } }
                    )
                }
            }
        }
    }
}

private struct RecoveryCard: View {
    let status: MusubiRecoveryStatus?
    let isGenerating: Bool
    let generate: () -> Void

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Recovery codes")
                        .font(.osn(.body, size: 18))
                    Spacer()
                    if let status, status.isRunningLow {
                        Pill("Running low", tint: OSNColor.badgeLive)
                    }
                }

                if let status {
                    if status.hasCodes {
                        Text("\(status.active) of \(status.total) left")
                            .font(.osn(.body, size: 14))
                        if let generatedAt = status.generatedAt {
                            Text("Made \(generatedAt, format: .relative(presentation: .named))")
                                .font(.osn(.body, size: 12))
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Text("You have none. Without a passkey and without codes, nobody can let you back in.")
                            .font(.osn(.body, size: 14))
                    }
                } else {
                    Text("Couldn't read your code count.")
                        .font(.osn(.body, size: 14))
                        .foregroundStyle(.secondary)
                }

                // "New codes" and not "Generate": a new set replaces the old
                // one whole, and the button should say so before the sheet
                // does.
                GlassButton(isGenerating ? "Working…" : "Make new codes", action: generate)
                    .disabled(isGenerating)

                Text("Making a new set cancels every code you have now.")
                    .font(.osn(.body, size: 12))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct SecurityEventRow: View {
    let event: MusubiSecurityEvent
    let isAcknowledging: Bool
    let acknowledge: () -> Void

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                Label(event.title, systemImage: event.systemImage)
                    .font(.osn(.body, size: 18))

                Text(event.createdAt, format: .relative(presentation: .named))
                    .font(.osn(.body, size: 14))

                Text(event.displayDevice)
                    .font(.osn(.body, size: 12))
                    .foregroundStyle(.secondary)

                if let location = event.displayLocation {
                    // A hash, not an address. Same prefix on two rows means
                    // the same place, which is the only question it answers.
                    Text("From \(location)")
                        .font(.osn(.body, size: 12))
                        .foregroundStyle(.secondary)
                }

                GlassButton(
                    isAcknowledging ? "Working…" : "I know about this",
                    kind: .secondary,
                    action: acknowledge
                )
                .disabled(isAcknowledging)
            }
        }
    }
}

/// The one and only sighting of a set of codes.
///
/// `ShareLink` rather than a copy button: `UIPasteboard` is UIKit, this
/// package must build against macOS too, and the share sheet already offers
/// copy alongside every other way of keeping them.
private struct RecoveryCodesSheet: View {
    @Environment(\.dismiss) private var dismiss
    let codes: [String]

    private var joined: String { codes.joined(separator: "\n") }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Save these somewhere safe. They won't be shown again, and each one works once.")
                        .font(.osn(.body, size: 14))

                    ForEach(codes, id: \.self) { code in
                        Text(code)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                    }

                    ShareLink(item: joined) {
                        Text("Share or copy")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .navigationTitle("Your recovery codes")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
