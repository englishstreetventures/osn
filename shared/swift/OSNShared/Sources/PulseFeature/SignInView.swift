import OSNAuth
import OSNUI
import SwiftUI

/// Passkey sign-in screen. Offers a discoverable/conditional-UI flow
/// (`identifier: nil`) and a typed-identifier flow; never branches on
/// whether the server recognised the identifier, since it deliberately
/// fabricates `allowCredentials` for unknown ones.
public struct SignInView: View {
    private let session: PulseSession
    private let anchorProvider: PresentationAnchorProvider

    @State private var identifier = ""
    @State private var isSigningIn = false
    @State private var errorMessage: String?

    public init(session: PulseSession, anchorProvider: @escaping PresentationAnchorProvider) {
        self.session = session
        self.anchorProvider = anchorProvider
    }

    public var body: some View {
        VStack(spacing: 24) {
            Text("Pulse")
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
