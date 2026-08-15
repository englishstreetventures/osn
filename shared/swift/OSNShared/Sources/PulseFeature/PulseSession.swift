import Foundation
import Observation
import OSNAuth
import OSNKit
import PulseAPI

/// Owns Pulse auth state for the whole app shell. Builds the shared
/// `URLSession`/`TokenRefresher`/Pulse `Client` once and holds them
/// internally — no feature view ever sees an access token, only this
/// object's `api` (an `APIProtocol`, generated from `shared/openapi/pulse.json`
/// at build time and produced only by `makePulseClient`).
@MainActor
@Observable
public final class PulseSession {
    /// `.signedIn` carries an *optional* profile, not the non-optional one
    /// the brief describes. A silent restore only round-trips
    /// `TokenRefresher.refresh()`, which returns a `TokenGrant` — never a
    /// `PasskeyProfile` — and no OSNAuth endpoint exposes "fetch current
    /// profile" (`PasskeyManagementClient` only lists/renames/deletes
    /// passkeys). So a restored session starts as `.signedIn(nil)`; an
    /// interactive `signIn(...)` populates the profile from
    /// `PasskeyLoginCompleteResponse.profile`.
    public enum SessionState: Equatable {
        case restoring
        case signedOut
        case signedIn(PasskeyProfile?)
        case failed(String)
    }

    public private(set) var state: SessionState = .restoring

    /// Every Pulse call in this feature goes through this client.
    public let api: any APIProtocol

    private let tokenRefresher: TokenRefresher
    private let loginClient: PasskeyLoginClient

    /// - Parameters:
    ///   - environment: identity host for passkey ceremonies + token
    ///     refresh. Defaults to `.local` — no deployed Pulse API host exists
    ///     yet, so this is development-oriented, not a hardcoded prod value.
    ///   - pulseEnvironment: Pulse API host for `api`. Defaults to `.local`
    ///     for the same reason.
    /// - Throws: whatever `SharedCookieJar.makeSession()` throws
    ///   (`OSNKitError.appGroupContainerUnavailable` when the App Group
    ///   container doesn't resolve — the group is registered, so this means
    ///   the target is missing the entitlement or is signed by another team;
    ///   see `pulse/ios/project.yml`). That is an infrastructure/build-config
    ///   failure, not a session state — there is no working `URLSession` to
    ///   hand out if it happens, so it isn't folded into `SessionState`.
    public init(environment: Environment = .local, pulseEnvironment: PulseEnvironment = .local) throws {
        let session = try SharedCookieJar.makeSession()
        let tokenRefresher = TokenRefresher(session: session, environment: environment)
        self.tokenRefresher = tokenRefresher
        self.loginClient = PasskeyLoginClient(session: session, environment: environment)
        self.api = makePulseClient(environment: pulseEnvironment, session: session, tokenRefresher: tokenRefresher)
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
    /// `KeychainAccessTokenStore.delete()` here is defensive, per the
    /// brief's deliverable 2 — `delete()` treats "already gone" as success
    /// (`errSecItemNotFound`), so calling it after `logout()` is a no-op,
    /// not a race.
    public func signOut() async {
        try? await tokenRefresher.logout()
        try? KeychainAccessTokenStore.delete()
        state = .signedOut
    }
}
