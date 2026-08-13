import OSNUI
import SwiftUI

/// Devices screen: every session signed in to this account, with revoke.
///
/// This is Musubi's first real surface, and deliberately so — it is backed
/// end to end by endpoints that already exist (`listSessions`,
/// `revokeSession`, `revokeAllOtherSessions`), needs no new API work, and
/// is the one screen that proves the shared cookie jar: sign in on Pulse
/// and this app's session appears in the list.
public struct DevicesView: View {
    @State private var viewModel: DevicesViewModel

    public init(session: MusubiSession) {
        _viewModel = State(
            wrappedValue: DevicesViewModel(
                api: OSNDevicesAPI(client: session.api),
                onSessionEnded: { await session.signOut() }
            )
        )
    }

    public var body: some View {
        content
            .navigationTitle("Devices")
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
                    "Couldn't load your devices",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
            case .loaded:
                // Only reachable if the account has no live session at all,
                // which the act of viewing this screen rules out. Kept
                // rather than force-unwrapped: a list is a list.
                ContentUnavailableView(
                    "No devices",
                    systemImage: "laptopcomputer.and.iphone",
                    description: Text("Sessions you sign in with show up here.")
                )
            }
        } else {
            list
        }
    }

    private var list: some View {
        ScrollView {
            GlassEffectContainer {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if let revokeError = viewModel.revokeError {
                        Text(revokeError)
                            .font(.osn(.body, size: 14))
                            .foregroundStyle(.red)
                    }

                    ForEach(viewModel.devices) { device in
                        DeviceRow(
                            device: device,
                            isRevoking: viewModel.revokingID == device.id,
                            revoke: { Task { await viewModel.revoke(id: device.id) } }
                        )
                    }

                    if viewModel.devices.contains(where: { !$0.isCurrent }) {
                        GlassButton("Sign out everywhere else", kind: .secondary) {
                            Task { await viewModel.revokeAllOthers() }
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

private struct DeviceRow: View {
    let device: MusubiDevice
    let isRevoking: Bool
    let revoke: () -> Void

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(device.displayLabel)
                        .font(.osn(.body, size: 18))
                    Spacer()
                    if device.isCurrent {
                        Pill("This device", tint: OSNColor.accent)
                    }
                }

                // Relative, because "3 days ago" answers "is anything on
                // here not me?" and a timestamp doesn't.
                Text("Last used \(device.lastActive, format: .relative(presentation: .named))")
                    .font(.osn(.body, size: 14))
                Text("Signed in \(device.createdAt, format: .relative(presentation: .named))")
                    .font(.osn(.body, size: 12))
                    .foregroundStyle(.secondary)

                GlassButton(
                    isRevoking ? "Signing out…" : (device.isCurrent ? "Sign out" : "Sign out this device"),
                    kind: .secondary,
                    action: revoke
                )
                .disabled(isRevoking)
            }
        }
    }
}
