import Foundation
import Observation
import OSNAuth
import OSNKit
import PulseAPI

/// Owns Pulse auth state for the whole app shell. Forwards restore/sign-in/
/// sign-out to the shared `OSNSession` (`auth`) and additionally builds the
/// Pulse `Client` once and holds it internally — no feature view ever sees
/// an access token, only this object's `api` (an `APIProtocol`, generated
/// from `shared/openapi/pulse.json` at build time and produced only by
/// `makePulseClient`).
@MainActor
@Observable
public final class PulseSession {
    public typealias SessionState = OSNSession.SessionState

    /// Computed, not a stored copy synced on events — a stored copy would
    /// break `@Observable` change tracking, since observers would be
    /// tracking this property instead of `auth.state`.
    public var state: SessionState { auth.state }

    /// The app-agnostic half of sign-in, shared with other OSN apps.
    public let auth: OSNSession

    /// Every Pulse call in this feature goes through this client.
    public let api: any APIProtocol

    /// - Parameters:
    ///   - environment: identity host for passkey ceremonies + token refresh.
    ///   - pulseEnvironment: Pulse API host for `api`.
    ///
    /// Neither has a default. They used to default to `.local`, which meant a
    /// release build silently talked to `localhost` — see
    /// `Environment.resolve(info:)`, which the app target calls to derive
    /// both from the build configuration.
    public init(environment: Environment, pulseEnvironment: PulseEnvironment) throws {
        let auth = try OSNSession(environment: environment)
        self.auth = auth
        self.api = makePulseClient(environment: pulseEnvironment, session: auth.urlSession, tokenRefresher: auth.tokenRefresher)
    }

    public func restore() async {
        await auth.restore()
    }

    /// S-H1 foreground hook — forwarded to `OSNSession.revalidate()` so a
    /// profile cached while backgrounded is checked against whatever token a
    /// sibling app (Musubi; same cookie jar, same Keychain slot) may have
    /// rotated in while Pulse was away.
    public func revalidate() async {
        await auth.revalidate()
    }

    public func signIn(
        identifier: String?,
        anchorProvider: @escaping PresentationAnchorProvider
    ) async throws {
        try await auth.signIn(identifier: identifier, anchorProvider: anchorProvider)
    }

    public func signOut() async {
        await auth.signOut()
    }
}
