import OSNAuth
import SwiftUI

/// Read-only account screen: the signed-in profile (when the session carries
/// one — a restored session doesn't, and there is no "fetch current profile"
/// endpoint to fill that in) plus the account's passkeys. Rename and delete
/// need a step-up ceremony (`wiki/systems/step-up.md`) and are out of scope
/// here — no buttons for either.
public struct MusubiAccountView: View {
    private let session: OSNSession

    @State private var passkeys: [PasskeySummary] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    public init(session: OSNSession) {
        self.session = session
    }

    public var body: some View {
        List {
            Section("Profile") {
                if case .signedIn(let profile?) = session.state {
                    Text(profile.displayName ?? profile.handle)
                    Text(profile.email)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Signed in")
                        .foregroundStyle(.secondary)
                }
            }

            Section("Passkeys") {
                if isLoading {
                    ProgressView()
                } else if let errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                    Button("Retry") {
                        Task { await loadPasskeys() }
                    }
                } else if passkeys.isEmpty {
                    Text("No passkeys")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(passkeys, id: \.id) { passkey in
                        Text(passkey.label ?? passkey.id)
                    }
                }
            }

            Section {
                Button("Sign out", role: .destructive) {
                    Task { await session.signOut() }
                }
            }
        }
        .task {
            await loadPasskeys()
        }
    }

    private func loadPasskeys() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            passkeys = try await fetchPasskeys(session: session)
        } catch {
            errorMessage = String(describing: error)
        }
    }
}

/// The network half of `MusubiAccountView.loadPasskeys()`, pulled out so a
/// test can reach it: refreshes the access token if it's missing or about
/// to expire, then lists passkeys. Contract this exists to protect — a
/// failing `list()` must throw without ever mutating `session.state`, i.e.
/// a passkey-list failure must not sign the user out. `session.state` is
/// `private(set)`; nothing below this call has any way to write to it, and
/// that's what makes the contract checkable from a test rather than merely
/// asserted in a comment.
@MainActor
func fetchPasskeys(session: OSNSession) async throws -> [PasskeySummary] {
    try await session.ensureFreshAccessToken()
    let client = PasskeyManagementClient(session: session.urlSession, environment: .local)
    return try await client.list()
}
