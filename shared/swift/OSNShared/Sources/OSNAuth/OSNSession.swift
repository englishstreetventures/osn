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
    ///
    /// Brief T3 §4 modal collision: only one `ASAuthorizationController`
    /// request can be live at a time. Cancels a still-armed autofill
    /// request before starting the modal ceremony, and re-arms autofill
    /// (same `anchorProvider`) if the modal flow throws or is cancelled —
    /// a failed/cancelled button tap should not leave the QuickType
    /// suggestion gone too.
    public func signIn(
        identifier: String?,
        anchorProvider: @escaping PresentationAnchorProvider
    ) async throws {
        #if os(iOS)
        cancelAutoFillSignIn()
        #endif
        do {
            let response = try await loginClient.signIn(identifier: identifier, anchorProvider: anchorProvider)
            state = .signedIn(response.profile)
        } catch {
            #if os(iOS)
            // Detached and never awaited, but *tracked* — see
            // `autoFillReArmTask`. `startAutoFillSignIn` does not return
            // until the ceremony it arms completes, which for a QuickType
            // suggestion means "when the user taps it", i.e. usually never.
            // Awaiting it here would hold `signIn` open past the modal
            // failure, and `PasskeySignInView` leaves its button disabled and
            // its error unshown for exactly as long as `signIn` runs.
            autoFillReArmTask = Task { [weak self] in
                await self?.startAutoFillSignIn(anchorProvider: anchorProvider)
            }
            #endif
            throw error
        }
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

    #if os(iOS)
    private var autoFillHandle: PasskeyCeremonyHandle?

    /// The re-arm `Task` `signIn`'s catch spawns. Held so
    /// `cancelAutoFillSignIn()` can cancel it as well as the armed handle:
    /// the Task does not reach `autoFillHandle = handle` until a
    /// `beginLogin` round trip has finished, so a view that disappears
    /// inside that window would otherwise call `cancelAutoFillSignIn()`
    /// against a `nil` handle, cancel nothing, and let the Task go on to
    /// arm a ceremony no later call can reach.
    private var autoFillReArmTask: Task<Void, Never>?

    /// Clears `autoFillHandle` only if it still points at the caller's own
    /// handle. Two autofill attempts can overlap — the first suspended in
    /// `handle.result()` while the second arms — and the first one waking
    /// up to an unconditional `autoFillHandle = nil` would drop the second's
    /// handle on the floor, leaving it armed and uncancellable.
    private func clearAutoFillHandle(_ handle: PasskeyCeremonyHandle) {
        if autoFillHandle === handle {
            autoFillHandle = nil
        }
    }

    /// Conditional UI (brief T3 §4): arms `performAutoFillAssistedRequests()`
    /// so the account's passkey shows up in the QuickType bar, letting a
    /// returning user sign in with a tap instead of "Sign in with passkey".
    /// Never throws and never lands on `.failed` — see
    /// `attemptAutoFillSignIn` for why.
    public func startAutoFillSignIn(anchorProvider: @escaping PresentationAnchorProvider) async {
        await attemptAutoFillSignIn(anchorProvider: anchorProvider, isRetry: false)
    }

    public func cancelAutoFillSignIn() {
        autoFillReArmTask?.cancel()
        autoFillReArmTask = nil
        autoFillHandle?.cancel()
        autoFillHandle = nil
    }

    /// The server's passkey challenge lives 120 seconds
    /// (`osn/api/src/services/auth/constants.ts` `CHALLENGE_TTL_MS`). An
    /// autofill request typically sits armed in the QuickType bar far
    /// longer than that before the user taps it, so a non-cancellation
    /// failure here is almost always an expired challenge, not a bad
    /// credential — surfacing `.failed` for it would blame the user for
    /// waiting. On such a failure this re-arms once with a fresh challenge
    /// and stays silent; if the retry also fails it gives up and stays
    /// `.signedOut`. Deliberately does not loop on a timer under the 120s
    /// TTL instead: cancelling and re-issuing the request flickers the
    /// QuickType suggestion, which is worse than leaving a slightly stale
    /// one armed until the user acts or the view disappears.
    private func attemptAutoFillSignIn(anchorProvider: @escaping PresentationAnchorProvider, isRetry: Bool) async {
        guard !Task.isCancelled else { return }
        var armed: PasskeyCeremonyHandle?
        do {
            let begun = try await loginClient.beginLogin(identifier: nil, turnstileToken: nil)
            let assertionRequest = try loginClient.makeAssertionRequest(from: begun)
            guard !Task.isCancelled else { return }
            let handle = PasskeyCeremonyHandle(
                requests: [assertionRequest],
                autoFill: true,
                anchorProvider: anchorProvider
            )
            armed = handle
            // Cancel-before-arm. Only one `ASAuthorizationController` request
            // can be live, and `cancelAutoFillSignIn()` can only reach the one
            // handle this property holds — so overwriting a live handle would
            // strand a second live controller with no way to cancel it.
            autoFillHandle?.cancel()
            autoFillHandle = handle
            let authorization = try await handle.result()
            clearAutoFillHandle(handle)
            let target = try loginClient.loginTarget(identifier: nil, begun: begun)
            let assertion = try loginClient.packageAssertion(authorization)
            let response = try await loginClient.complete(target: target, assertion: assertion)
            // Deliberately not gated on `Task.isCancelled`: the ceremony and
            // the `complete` call both succeeded, so the session *is* signed
            // in server-side. Dropping the state here because the view went
            // away would leave the app showing signed-out over a live session.
            state = .signedIn(response.profile)
        } catch is CancellationError {
            if let armed { clearAutoFillHandle(armed) }
        } catch let error as PasskeyCeremonyError {
            if let armed { clearAutoFillHandle(armed) }
            if case .cancelled = error { return }
            if !isRetry {
                await attemptAutoFillSignIn(anchorProvider: anchorProvider, isRetry: true)
            }
        } catch {
            if let armed { clearAutoFillHandle(armed) }
            if !isRetry {
                await attemptAutoFillSignIn(anchorProvider: anchorProvider, isRetry: true)
            }
        }
    }
    #endif
}
