import Foundation
import Observation
import OSNKit

/// Reconciliation between a cached profile and the claims of the access
/// token actually in the Keychain right now (S-H1: two apps share one
/// cookie jar and one Keychain slot but each keeps its own `OSNSession`,
/// so a stale cached profile can silently belong to a different signed-in
/// user than the live token). The token is the truth; the cache is only
/// trusted when it still names the same subject.
///
/// Pure, no Keychain access, no state — the testable seam for this fix,
/// same spirit as `MusubiFeature.shouldRestore(_:)`.
///
/// - `claims == nil` → `nil`. Fail closed: no decodable token means no
///   identity to show, never guess.
/// - `claims != nil` and `cached?.id == claims.sub` → `cached` unchanged,
///   which keeps `avatarUrl` (a field claims cannot supply).
/// - otherwise → a fresh `PasskeyProfile` built from the claims, with
///   `avatarUrl: nil` — the token now names someone the cache doesn't
///   already know.
func reconciledProfile(cached: PasskeyProfile?, claims: AccessTokenClaims?) -> PasskeyProfile? {
    guard let claims else { return nil }
    if let cached, cached.id == claims.sub {
        return cached
    }
    return PasskeyProfile(
        id: claims.sub,
        handle: claims.handle,
        email: claims.email,
        displayName: claims.displayName,
        avatarUrl: nil
    )
}

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
    /// `PasskeyLoginCompleteResponse.profile`, and `reconcileIdentity()`
    /// fills it in afterward from the access token's own claims (S-H1) —
    /// see `reconciledProfile(cached:claims:)`.
    public enum SessionState: Equatable, Sendable {
        case restoring
        case signedOut
        case signedIn(PasskeyProfile?)
        case failed(String)
    }

    public private(set) var state: SessionState = .restoring

    /// The identity host this session talks to. Held so a caller building
    /// its own OSNAuth client (e.g. Musubi's passkey list) uses the same one
    /// rather than reaching for a literal — `MusubiAccountView` hardcoded
    /// `.local` before this existed.
    public let environment: Environment

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
    /// `OSNSession` wired to `OSNTesting`'s `MockURLProtocol` and assert deterministically
    /// on its behaviour instead of depending on a real network call failing.
    init(
        environment: Environment,
        urlSession: URLSession,
        tokenRefresher: TokenRefresher,
        loginClient: PasskeyLoginClient
    ) {
        self.environment = environment
        self.urlSession = urlSession
        self.tokenRefresher = tokenRefresher
        self.loginClient = loginClient
    }

    /// - Parameter environment: identity host for passkey ceremonies + token
    ///   refresh.
    /// - Throws: whatever `SharedCookieJar.makeSession()` throws
    ///   (`OSNKitError.appGroupContainerUnavailable` when the App Group
    ///   container doesn't resolve — the group is registered, so this means
    ///   the target is missing the entitlement or is signed by another team;
    ///   see `pulse/ios/project.yml`). That is an infrastructure/build-config
    ///   failure, not a session state — there is no working `URLSession` to
    ///   hand out if it happens, so it isn't folded into `SessionState`.
    ///
    /// `environment` has no default. It defaulted to `.local`, which meant a
    /// release build silently talked to `localhost`; app targets now derive it
    /// from the build configuration via `Environment.resolve(info:)`.
    public convenience init(environment: Environment) throws {
        let session = try SharedCookieJar.makeSession()
        let tokenRefresher = TokenRefresher(session: session, environment: environment)
        let loginClient = PasskeyLoginClient(session: session, environment: environment)
        self.init(
            environment: environment,
            urlSession: session,
            tokenRefresher: tokenRefresher,
            loginClient: loginClient
        )
    }

    /// Silent restore on launch. A throw from `TokenRefresher.refresh()`
    /// (no session cookie, expired session, etc. — see `OSNKitError`) means
    /// "signed out", not an error banner, per the brief. `reconcileIdentity()`
    /// immediately supplies the profile the freshly refreshed token names
    /// (S-H1) — `.signedIn(nil)` is a transient inner state, not the
    /// steady-state result.
    public func restore() async {
        state = .restoring
        do {
            try await tokenRefresher.refresh()
            state = .signedIn(nil)
            reconcileIdentity()
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
        guard !isFresh else {
            reconcileIdentity()
            return
        }
        try await tokenRefresher.refresh()
        reconcileIdentity()
    }

    /// S-H1: every authenticated call goes through `ensureFreshAccessToken()`,
    /// so reconciling here on both the already-fresh and just-refreshed paths
    /// closes the hole — a sibling app rotating the shared Keychain token to a
    /// different user's is caught on the very next call this app makes, not
    /// just at launch.
    ///
    /// Loads whatever access token is in the Keychain right now, decodes its
    /// claims (`AccessTokenClaims`, not signature-verified — see its doc),
    /// and — only when `state` is already `.signedIn` — replaces the profile
    /// with `reconciledProfile(cached:claims:)`'s result. Never touches
    /// `.signedOut`/`.restoring`/`.failed`. A `Keychain` read failure is
    /// treated the same as "no token": `reconciledProfile` then returns `nil`,
    /// which is the fail-closed behaviour the brief asks for. Skips the write
    /// when the reconciled profile equals the cached one, so `@Observable`
    /// doesn't churn on every call.
    private func reconcileIdentity() {
        guard case .signedIn(let cached) = state else { return }
        let stored = try? KeychainAccessTokenStore.load()
        let claims = stored.flatMap { AccessTokenClaims(jwt: $0.token) }
        let reconciled = reconciledProfile(cached: cached, claims: claims)
        guard reconciled != cached else { return }
        state = .signedIn(reconciled)
    }

    /// Foreground entry point (S-H1): call when the app becomes active so a
    /// profile cached while backgrounded is checked against whatever token a
    /// sibling app (same cookie jar, same Keychain slot) may have rotated in
    /// while this app was away.
    ///
    /// No-ops outside `.signedIn` — reviving a signed-out session because a
    /// sibling app is signed in is out of scope here (that is `restore()`'s
    /// job, run at launch, not at every foreground).
    public func revalidate() async {
        guard case .signedIn = state else { return }
        do {
            try await ensureFreshAccessToken()
        } catch OSNKitError.refreshSessionInvalid {
            // The shared session is genuinely dead — this is not a case
            // `reconcileIdentity()` can paper over with a different profile.
            state = .signedOut
        } catch {
            // Network hiccup, malformed response, etc. Leave the sign-in
            // state alone, but still reconcile against whatever token is
            // already in the Keychain — a wrong name must never linger on
            // screen just because a refresh attempt failed.
            reconcileIdentity()
        }
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
