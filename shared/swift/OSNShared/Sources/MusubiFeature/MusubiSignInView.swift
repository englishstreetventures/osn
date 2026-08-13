import OSNAuth
import OSNUI
import SwiftUI

/// Passkey sign-in for Musubi. Same two flows as Pulse's `SignInView` — a
/// discoverable/conditional-UI ceremony (`identifier: nil`) and a typed
/// identifier — and the same rule: never branch on whether the server
/// recognised the identifier, since it deliberately fabricates
/// `allowCredentials` for unknown ones.
///
/// This is a near-twin of `SignInView` and stays a separate type on
/// purpose: the two differ in wordmark and session type today, and the app
/// they belong to will pull them apart further. Hoisting a shared
/// sign-in view into `OSNUI` is worth doing once a third app wants it, not
/// on the second.
public struct MusubiSignInView: View {
    private let session: MusubiSession
    private let anchorProvider: PresentationAnchorProvider

    @State private var identifier = ""
    @State private var isSigningIn = false
    @State private var errorMessage: String?

    public init(session: MusubiSession, anchorProvider: @escaping PresentationAnchorProvider) {
        self.session = session
        self.anchorProvider = anchorProvider
    }

    public var body: some View {
        VStack(spacing: 24) {
            Text("Musubi")
                .font(.osn(.display, size: 40))

            TextField("Handle or email", text: $identifier)
                #if os(iOS)
                    .textInputAutocapitalization(.never)
                #endif
                .autocorrectionDisabled()
                .textContentType(.username)
                .padding()
                .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

            if let errorMessage {
                Text(errorMessage)
                    .font(.osn(.body, size: 14))
                    .foregroundStyle(.red)
            }

            GlassButton(isSigningIn ? "Signing in…" : "Sign in with passkey", kind: .primary) {
                signIn(identifier: identifier.isEmpty ? nil : identifier)
            }
            .disabled(isSigningIn)

            GlassButton("Use any passkey on this device", kind: .secondary) {
                signIn(identifier: nil)
            }
            .disabled(isSigningIn)
        }
        .padding()
    }

    private func signIn(identifier: String?) {
        errorMessage = nil
        isSigningIn = true
        Task {
            defer { isSigningIn = false }
            do {
                try await session.signIn(identifier: identifier, anchorProvider: anchorProvider)
            } catch let error as PasskeyCeremonyError {
                if case .cancelled = error {
                    return
                }
                errorMessage = String(describing: error)
            } catch let error as OSNAuthError {
                errorMessage = error.description
            } catch {
                errorMessage = String(describing: error)
            }
        }
    }
}
