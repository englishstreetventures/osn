import Foundation
import Observation
import OSNAPI
import OSNAuth
import OSNKit

/// Owns Musubi auth state for the whole app shell, and is the second
/// consumer of the shared cookie jar: Pulse and Musubi both build their
/// `URLSession` from `SharedCookieJar.makeSession()`, so a sign-in in
/// either app is a sign-in in both — the session cookie lives in the
/// `group.social.musubi.session` App Group container, not in one app's
/// sandbox.
///
/// Structurally this mirrors `PulseSession`, with one difference that
/// matters: Musubi talks to osn-api itself, so the identity host and the
/// API host are the same `Environment` and there is only ever one
/// `TokenRefresher` here.
@MainActor
@Observable
public final class MusubiSession {
    /// Same shape as `PulseSession.SessionState`, and optional for the same
    /// reason: a silent restore only round-trips `TokenRefresher.refresh()`,
    /// which returns a `TokenGrant`, never a `PasskeyProfile`.
    public enum SessionState: Equatable {
        case restoring
        case signedOut
        case signedIn(PasskeyProfile?)
        case failed(String)
    }

    public private(set) var state: SessionState = .restoring

    /// Every osn-api call in this feature goes through this client. The
    /// bearer middleware inside it consults `OSNAuthenticatedOperations`,
    /// so the sign-in and `/token` calls go out with no `Authorization`
    /// header while `listSessions` and friends get one.
    public let api: any APIProtocol

    private let tokenRefresher: TokenRefresher
    private let loginClient: PasskeyLoginClient

    /// - Parameter environment: identity host for passkey ceremonies, token
    ///   refresh *and* the API. Defaults to `.local`; the app target picks
    ///   `.production` (`id.musubi.social`) when it ships.
    /// - Throws: whatever `SharedCookieJar.makeSession()` throws
    ///   (`OSNKitError.appGroupContainerUnavailable` while the App Group
    ///   entitlement is still unregistered — see `osn/ios/project.yml`'s
    ///   `BLOCKED:` comment). No working `URLSession` means no session at
    ///   all, so it isn't folded into `SessionState`.
    public init(environment: Environment = .local) throws {
        let session = try SharedCookieJar.makeSession()
        let tokenRefresher = TokenRefresher(session: session, environment: environment)
        self.tokenRefresher = tokenRefresher
        self.loginClient = PasskeyLoginClient(session: session, environment: environment)
        self.api = makeOSNClient(environment: environment, session: session, tokenRefresher: tokenRefresher)
    }

    /// Silent restore on launch. A throw from `TokenRefresher.refresh()`
    /// means "signed out", not an error banner.
    public func restore() async {
        state = .restoring
        do {
            try await tokenRefresher.refresh()
            state = .signedIn(nil)
        } catch {
            state = .signedOut
        }
    }

    public func signIn(
        identifier: String?,
        anchorProvider: @escaping PresentationAnchorProvider
    ) async throws {
        let response = try await loginClient.signIn(identifier: identifier, anchorProvider: anchorProvider)
        state = .signedIn(response.profile)
    }

    /// Also the landing point for "I just revoked the session I'm sitting
    /// on" — `revokeSession` on the current session leaves the app holding
    /// an access token the server will stop honouring, so the devices
    /// screen calls this rather than pretending the row simply vanished.
    public func signOut() async {
        try? await tokenRefresher.logout()
        try? KeychainAccessTokenStore.delete()
        state = .signedOut
    }
}
