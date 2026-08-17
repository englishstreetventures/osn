import Foundation
import Observation
import OSNKit

/// Owns the app-agnostic half of passkey sign-in — restore, sign in, sign
/// out — shared across every OSN app. Builds the shared cookie-jar-backed
/// `URLSession`/`TokenRefresher` once and exposes both so an app-specific
/// session (e.g. `PulseFeature.PulseSession`) can build its own API client
/// on top without duplicating cookie-jar/token-refresh plumbing.
@MainActor
@Observable
public final class OSNSession {
    /// `.signedIn` carries an *optional* profile, not the non-optional one
    /// the brief describes. A silent restore only round-trips
    /// `TokenRefresher.refresh()`, which returns a `TokenGrant` — never a
    /// `PasskeyProfile` — and no OSNAuth endpoint exposes "fetch current
    /// profile" (`PasskeyManagementClient` only lists/renames/deletes
    /// passkeys). So a restored session starts as `.signedIn(nil)`; an
    /// interactive `signIn(...)` populates the profile from
    /// `PasskeyLoginCompleteResponse.profile`.
    public enum SessionState: Equatable, Sendable {
        case restoring
        case signedOut
        case signedIn(PasskeyProfile?)
        case failed(String)
    }

    public private(set) var state: SessionState = .restoring

    /// Shared cookie-jar-backed session and token refresher — every
    /// app-specific API client (e.g. `makePulseClient`) is built from these
    /// so it shares the same cookie jar and refresh-in-flight coalescing.
    public let urlSession: URLSession
    public let tokenRefresher: TokenRefresher

    private let loginClient: PasskeyLoginClient

    /// Test-only injection seam, mirroring `SharedCookieJar.makeConfiguration`'s
    /// `containerURLProvider` parameter: the public initializer always builds
    /// real dependencies from `environment`, and there is no way to swap in
    /// a mock `URLSession` through it. This lets `OSNAuthTests` construct an
    /// `OSNSession` wired to `LoginMockURLProtocol` and assert deterministically
    /// on its behaviour instead of depending on a real network call failing.
    init(urlSession: URLSession, tokenRefresher: TokenRefresher, loginClient: PasskeyLoginClient) {
        self.urlSession = urlSession
        self.tokenRefresher = tokenRefresher
        self.loginClient = loginClient
    }

    /// - Parameter environment: identity host for passkey ceremonies + token
    ///   refresh. Defaults to `.local` — no deployed Pulse API host exists
    ///   yet, so this is development-oriented, not a hardcoded prod value.
    /// - Throws: whatever `SharedCookieJar.makeSession()` throws
    ///   (`OSNKitError.appGroupContainerUnavailable` when the App Group
    ///   container doesn't resolve — the group is registered, so this means
    ///   the target is missing the entitlement or is signed by another team;
    ///   see `pulse/ios/project.yml`). That is an infrastructure/build-config
    ///   failure, not a session state — there is no working `URLSession` to
    ///   hand out if it happens, so it isn't folded into `SessionState`.
    public convenience init(environment: Environment = .local) throws {
        let session = try SharedCookieJar.makeSession()
        let tokenRefresher = TokenRefresher(session: session, environment: environment)
        let loginClient = PasskeyLoginClient(session: session, environment: environment)
        self.init(urlSession: session, tokenRefresher: tokenRefresher, loginClient: loginClient)
    }

    /// Silent restore on launch. A throw from `TokenRefresher.refresh()`
    /// (no session cookie, expired session, etc. — see `OSNKitError`) means
    /// "signed out", not an error banner, per the brief.
    public func restore() async {
        state = .restoring
        do {
            try await tokenRefresher.refresh()
            state = .signedIn(nil)
        } catch {
            state = .signedOut
        }
    }

    /// Runs the passkey ceremony (`identifier: nil` for discoverable UI, a
    /// typed identifier for the account-bound flow) and, on success, moves
    /// to `.signedIn(profile)`. Never branches on whether the `begin` step
    /// found an account — `PasskeyLoginClient.signIn` already keeps that
    /// opaque.
    public func signIn(
        identifier: String?,
        anchorProvider: @escaping PresentationAnchorProvider
    ) async throws {
        let response = try await loginClient.signIn(identifier: identifier, anchorProvider: anchorProvider)
        state = .signedIn(response.profile)
    }

    /// `TokenRefresher.logout()` already deletes the Keychain access token
    /// internally on every path (even a failed network call). The explicit
    /// `KeychainAccessTokenStore.delete()` here is defensive — `delete()`
    /// treats "already gone" as success (`errSecItemNotFound`), so calling
    /// it after `logout()` is a no-op, not a race.
    public func signOut() async {
        try? await tokenRefresher.logout()
        try? KeychainAccessTokenStore.delete()
        state = .signedOut
    }

    /// Loads the Keychain-stored access token and refreshes it if it's
    /// missing or expires within the next 30 seconds; otherwise does
    /// nothing. `RequestHelpers.applyBearerAccessToken` pastes whatever
    /// token is currently in the Keychain onto a request with no expiry
    /// check and no 401-retry, so a caller that skips this and waits out
    /// the 5-minute access-token TTL (`wiki/systems/identity-model.md`)
    /// 401s on its next request — e.g. the Musubi account screen's
    /// `PasskeyManagementClient.list()`. `TokenRefresher.refresh()` already
    /// persists the refreshed token to the Keychain; this method never
    /// writes to it directly.
    public func ensureFreshAccessToken() async throws {
        let stored = try KeychainAccessTokenStore.load()
        let isFresh = stored.map { $0.expiresAt.timeIntervalSinceNow > 30 } ?? false
        guard !isFresh else { return }
        try await tokenRefresher.refresh()
    }
}
