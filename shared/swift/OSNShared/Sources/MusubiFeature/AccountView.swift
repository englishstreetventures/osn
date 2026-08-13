import OSNAuth
import OSNUI
import SwiftUI

/// Account screen: the profiles on the account, the address it answers to, a
/// copy of everything it holds, and the button that ends it.
///
/// Everything here that can't be undone by pressing it again runs a passkey
/// ceremony first — changing the email, exporting, deleting. Restoring
/// doesn't, deliberately: see `AccountAPI.restore()`.
public struct AccountView: View {
    @State private var viewModel: AccountViewModel
    @State private var newEmail = ""
    @State private var code = ""
    @State private var confirmHandle = ""

    public init(
        session: MusubiSession,
        anchorProvider: @escaping PresentationAnchorProvider,
        currentProfileID: String? = nil,
        onSwitch: @escaping (MusubiProfile) -> Void = { _ in }
    ) {
        _viewModel = State(
            wrappedValue: AccountViewModel(
                api: session.makeAccountAPI(anchorProvider: anchorProvider),
                currentProfileID: currentProfileID,
                onSwitch: onSwitch
            )
        )
    }

    /// For previews and for a caller that already has an API of its own.
    public init(viewModel: AccountViewModel) {
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

                    // First, because it outranks everything else on the
                    // screen: there's a clock running.
                    if let deletion = viewModel.deletion, deletion.isScheduled {
                        RestoreCard(
                            scheduledFor: deletion.scheduledFor,
                            isRestoring: viewModel.isRestoring,
                            restore: { Task { await viewModel.restore() } }
                        )
                    }

                    profiles

                    EmailCard(
                        currentEmail: viewModel.profiles.first?.email,
                        pendingEmail: viewModel.pendingEmail,
                        newEmail: $newEmail,
                        code: $code,
                        isSendingCode: viewModel.isSendingCode,
                        isConfirming: viewModel.isConfirmingEmail,
                        send: {
                            Task {
                                await viewModel.beginEmailChange(to: newEmail)
                                if viewModel.pendingEmail != nil { newEmail = "" }
                            }
                        },
                        confirm: {
                            Task {
                                await viewModel.confirmEmailChange(code: code)
                                if viewModel.pendingEmail == nil { code = "" }
                            }
                        },
                        cancel: {
                            viewModel.cancelEmailChange()
                            code = ""
                        }
                    )

                    ExportCard(
                        isExporting: viewModel.isExporting,
                        export: { Task { await viewModel.exportAccount() } }
                    )

                    DeleteCard(
                        handle: viewModel.currentProfile?.handle,
                        confirmHandle: $confirmHandle,
                        isScheduled: viewModel.deletion?.isScheduled ?? false,
                        isRequesting: viewModel.isRequestingDeletion,
                        delete: {
                            Task {
                                await viewModel.requestDeletion(confirmHandle: confirmHandle)
                                confirmHandle = ""
                            }
                        }
                    )
                }
                .padding()
            }
        }
        .navigationTitle("Account")
        .refreshable {
            await viewModel.load()
        }
        .task {
            if viewModel.state == .idle {
                await viewModel.load()
            }
        }
        .sheet(isPresented: exportIsPresented) {
            if let url = viewModel.exportURL {
                ExportSheet(url: url)
            }
        }
    }

    /// Driven off `exportURL` and clearing it on dismissal, so the file on
    /// disk lives exactly as long as the sheet does.
    private var exportIsPresented: Binding<Bool> {
        Binding(
            get: { viewModel.exportURL != nil },
            set: { if !$0 { viewModel.dismissExport() } }
        )
    }

    @ViewBuilder
    private var profiles: some View {
        switch viewModel.state {
        case .idle:
            ProgressView()
        // A reload with rows already on screen keeps them: the refresh
        // control is the progress indicator there.
        case .loading where viewModel.profiles.isEmpty:
            ProgressView()
        case .failed(let message):
            ContentUnavailableView(
                "Couldn't load your account",
                systemImage: "exclamationmark.triangle",
                description: Text(message)
            )
        default:
            ForEach(viewModel.profiles) { profile in
                ProfileRow(
                    profile: profile,
                    isCurrent: profile.id == viewModel.currentProfileID,
                    canSwitch: viewModel.canSwitch,
                    isSwitching: viewModel.switchingID == profile.id,
                    isMakingDefault: viewModel.makingDefaultID == profile.id,
                    switchTo: { Task { await viewModel.switchProfile(id: profile.id) } },
                    makeDefault: { Task { await viewModel.makeDefault(id: profile.id) } }
                )
            }
        }
    }
}

private struct ProfileRow: View {
    let profile: MusubiProfile
    let isCurrent: Bool
    let canSwitch: Bool
    let isSwitching: Bool
    let isMakingDefault: Bool
    let switchTo: () -> Void
    let makeDefault: () -> Void

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(profile.title)
                        .font(.osn(.body, size: 18))
                    Spacer()
                    // Only shown when the app actually knows — a restored
                    // session doesn't, and marking a row on a guess would be
                    // worse than marking none.
                    if isCurrent {
                        Pill("Signed in", tint: OSNColor.badgeLive)
                    }
                }

                Text(profile.subtitle)
                    .font(.osn(.body, size: 14))
                    .foregroundStyle(.secondary)

                if canSwitch, !isCurrent {
                    GlassButton(isSwitching ? "Working…" : "Switch to this", action: switchTo)
                        .disabled(isSwitching)
                }

                // Where the next sign-in lands, on this device and any other.
                GlassButton(
                    isMakingDefault ? "Working…" : "Sign in as this by default",
                    kind: .secondary,
                    action: makeDefault
                )
                .disabled(isMakingDefault)
            }
        }
    }
}

/// The banner for an account on its way out. Restoring takes it back whole,
/// and only until `scheduledFor`.
private struct RestoreCard: View {
    let scheduledFor: Date?
    let isRestoring: Bool
    let restore: () -> Void

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("This account is being deleted", systemImage: "clock.badge.exclamationmark")
                    .font(.osn(.body, size: 18))

                if let scheduledFor {
                    Text("Everything goes \(scheduledFor, format: .relative(presentation: .named)). Until then you can take it back.")
                        .font(.osn(.body, size: 14))
                } else {
                    Text("You can still take it back.")
                        .font(.osn(.body, size: 14))
                }

                GlassButton(isRestoring ? "Working…" : "Keep my account", action: restore)
                    .disabled(isRestoring)
            }
        }
    }
}

/// Two steps in one card, because they are one job: the address only changes
/// when a code sent to it comes back.
private struct EmailCard: View {
    let currentEmail: String?
    let pendingEmail: String?
    @Binding var newEmail: String
    @Binding var code: String
    let isSendingCode: Bool
    let isConfirming: Bool
    let send: () -> Void
    let confirm: () -> Void
    let cancel: () -> Void

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                Text("Email")
                    .font(.osn(.body, size: 18))

                if let currentEmail {
                    Text(currentEmail)
                        .font(.osn(.body, size: 14))
                }

                if let pendingEmail {
                    Text("We sent a code to \(pendingEmail). Nothing has changed yet.")
                        .font(.osn(.body, size: 14))
                        .foregroundStyle(.secondary)

                    TextField("Code", text: $code)
                        .textContentType(.oneTimeCode)
                        .font(.system(.body, design: .monospaced))

                    GlassButton(isConfirming ? "Working…" : "Confirm the change", action: confirm)
                        .disabled(isConfirming || code.isEmpty)

                    GlassButton("Cancel", kind: .secondary, action: cancel)
                        .disabled(isConfirming)

                    // Worth saying before they press it, not after they find
                    // themselves signed out of their laptop.
                    Text("Changing your email signs out everywhere except this device.")
                        .font(.osn(.body, size: 12))
                        .foregroundStyle(.secondary)
                } else {
                    TextField("New email", text: $newEmail)
                        .textContentType(.emailAddress)
                        #if canImport(UIKit)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                        #endif
                        .autocorrectionDisabled()

                    GlassButton(isSendingCode ? "Working…" : "Send a code", action: send)
                        .disabled(isSendingCode || newEmail.isEmpty)
                }
            }
        }
    }
}

private struct ExportCard: View {
    let isExporting: Bool
    let export: () -> Void

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                Text("Your data")
                    .font(.osn(.body, size: 18))

                Text("A copy of everything this account holds, as a file you can keep or take elsewhere.")
                    .font(.osn(.body, size: 14))

                GlassButton(isExporting ? "Working…" : "Download a copy", action: export)
                    .disabled(isExporting)

                Text("Once a day.")
                    .font(.osn(.body, size: 12))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// `ShareLink` and not a save button: the file is already on disk, the share
/// sheet is how iOS puts it anywhere the user actually wants it, and
/// `UIPasteboard` is UIKit-only (this package builds against macOS too).
private struct ExportSheet: View {
    @Environment(\.dismiss) private var dismiss
    let url: URL

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Your copy is ready. It holds everything on your account in plain text, so put it somewhere you trust.")
                    .font(.osn(.body, size: 14))

                ShareLink(item: url) {
                    Text("Save or send it")
                }

                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .navigationTitle("Your data")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

/// Typing the handle is the confirmation — no alert, because an alert is one
/// tap away from a tap you didn't mean and this isn't.
private struct DeleteCard: View {
    let handle: String?
    @Binding var confirmHandle: String
    let isScheduled: Bool
    let isRequesting: Bool
    let delete: () -> Void

    /// When the app knows the handle it checks the typing here, so the user
    /// isn't told about a mismatch by a round trip. When it doesn't, the
    /// server checks — and answers 400 `handle_mismatch`.
    private var matches: Bool {
        guard let handle else { return !confirmHandle.isEmpty }
        return confirmHandle == handle
    }

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                Text("Delete this account")
                    .font(.osn(.body, size: 18))

                Text("Your profiles, your connections and everything you've posted. There's a grace period, and after it there isn't.")
                    .font(.osn(.body, size: 14))

                if isScheduled {
                    Text("Already on its way out — see the top of this screen.")
                        .font(.osn(.body, size: 14))
                        .foregroundStyle(.secondary)
                } else {
                    if let handle {
                        Text("Type @\(handle) to confirm.")
                            .font(.osn(.body, size: 12))
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Type your handle to confirm.")
                            .font(.osn(.body, size: 12))
                            .foregroundStyle(.secondary)
                    }

                    TextField("Handle", text: $confirmHandle)
                        #if canImport(UIKit)
                            .textInputAutocapitalization(.never)
                        #endif
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))

                    GlassButton(isRequesting ? "Working…" : "Delete my account", kind: .secondary, action: delete)
                        .disabled(isRequesting || !matches)
                        .tint(.red)
                }
            }
        }
    }
}
