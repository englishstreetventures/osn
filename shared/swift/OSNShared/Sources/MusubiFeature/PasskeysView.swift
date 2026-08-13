import OSNAuth
import OSNUI
import SwiftUI

/// Passkeys screen: every credential that can sign in to this account, with
/// rename, delete and add.
///
/// This is the surface `OSNAuth`'s management, step-up and enrolment clients
/// were built for and until now had no consumer. Everything on it except the
/// list runs a passkey ceremony first, which is why there are no
/// "are you sure?" sheets: Face ID *is* the confirmation, and a dialog in
/// front of it would only train the user to tap through both.
public struct PasskeysView: View {
    @State private var viewModel: PasskeysViewModel
    @State private var renameTarget: MusubiPasskey?
    @State private var renameLabel = ""

    public init(session: MusubiSession, anchorProvider: @escaping PresentationAnchorProvider) {
        _viewModel = State(
            wrappedValue: PasskeysViewModel(api: session.makePasskeysAPI(anchorProvider: anchorProvider))
        )
    }

    /// For previews and for a caller that already has an API of its own.
    public init(viewModel: PasskeysViewModel) {
        _viewModel = State(wrappedValue: viewModel)
    }

    public var body: some View {
        content
            .navigationTitle("Passkeys")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Add", systemImage: "plus") {
                        Task { await viewModel.add() }
                    }
                    .disabled(viewModel.isAdding)
                }
            }
            .task {
                if viewModel.isEmpty {
                    await viewModel.load()
                }
            }
            .alert("Rename passkey", isPresented: renameIsPresented, presenting: renameTarget) { passkey in
                TextField("Name", text: $renameLabel)
                Button("Cancel", role: .cancel) {}
                Button("Rename") {
                    Task { await viewModel.rename(id: passkey.id, label: renameLabel) }
                }
            } message: { _ in
                Text("Names are only for you — they help you tell your devices apart.")
            }
    }

    private var renameIsPresented: Binding<Bool> {
        Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil } }
        )
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isEmpty {
            switch viewModel.state {
            case .idle, .loading:
                ProgressView()
            case .failed(let message):
                ContentUnavailableView(
                    "Couldn't load your passkeys",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
            case .loaded:
                // An account always has at least one passkey, so this is
                // unreachable in practice. Kept rather than force-unwrapped:
                // a list is a list.
                ContentUnavailableView(
                    "No passkeys",
                    systemImage: "person.badge.key",
                    description: Text("Passkeys you add show up here.")
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
                    if let mutationError = viewModel.mutationError {
                        Text(mutationError)
                            .font(.osn(.body, size: 14))
                            .foregroundStyle(.red)
                    }

                    ForEach(viewModel.passkeys) { passkey in
                        PasskeyRow(
                            passkey: passkey,
                            isMutating: viewModel.mutatingID == passkey.id,
                            canDelete: viewModel.canDelete,
                            rename: {
                                renameLabel = passkey.label ?? ""
                                renameTarget = passkey
                            },
                            delete: { Task { await viewModel.delete(id: passkey.id) } }
                        )
                    }

                    GlassButton(viewModel.isAdding ? "Adding…" : "Add a passkey") {
                        Task { await viewModel.add() }
                    }
                    .disabled(viewModel.isAdding)
                }
                .padding()
            }
        }
        .refreshable {
            await viewModel.load()
        }
    }
}

private struct PasskeyRow: View {
    let passkey: MusubiPasskey
    let isMutating: Bool
    let canDelete: Bool
    let rename: () -> Void
    let delete: () -> Void

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(passkey.displayLabel)
                        .font(.osn(.body, size: 18))
                    Spacer()
                    if passkey.isSynced {
                        Pill("Synced", tint: OSNColor.accent)
                    }
                }

                // The one state worth saying out loud: a passkey that could
                // be backed up but isn't lives on one device, and losing
                // that device loses the account.
                if passkey.isDeviceBound {
                    Text("On this device only — it won't survive losing it.")
                        .font(.osn(.body, size: 12))
                        .foregroundStyle(.secondary)
                }

                Text("Last used \(passkey.lastActive, format: .relative(presentation: .named))")
                    .font(.osn(.body, size: 14))
                Text("Added \(passkey.createdAt, format: .relative(presentation: .named))")
                    .font(.osn(.body, size: 12))
                    .foregroundStyle(.secondary)

                HStack {
                    GlassButton(isMutating ? "Working…" : "Rename", kind: .secondary, action: rename)
                        .disabled(isMutating)

                    if canDelete {
                        GlassButton("Remove", kind: .secondary, action: delete)
                            .disabled(isMutating)
                    }
                }
            }
        }
    }
}
