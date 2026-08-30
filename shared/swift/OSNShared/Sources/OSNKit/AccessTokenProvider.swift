import Foundation

/// An access token resolved for one outgoing request, plus where it came
/// from.
///
/// `wasJustMinted` is not bookkeeping: a token that arrived from a `/token`
/// grant milliseconds ago and is then rejected will be rejected again, so a
/// refresh-and-retry on it buys a second round trip and a second session-cookie
/// rotation for nothing. Callers use it to skip the retry in exactly that case.
public struct ResolvedAccessToken: Sendable, Equatable {
    public let token: String
    /// `true` when resolving this request minted the token, `false` when it
    /// came out of the Keychain.
    public let wasJustMinted: Bool

    public init(token: String, wasJustMinted: Bool) {
        self.token = token
        self.wasJustMinted = wasJustMinted
    }
}

/// The one place that decides when a stored access token is too near expiry
/// to send, and the one path that fetches a fresh one.
///
/// Both authenticated request paths in this package resolve their bearer
/// token here — `AuthenticatedTransport` behind the `OSNAuth` clients, and
/// `BearerTokenMiddleware` in front of the generated Pulse client — so the
/// skew allowance is written once instead of once per path, and each path
/// performs exactly one Keychain read per request.
///
/// Nothing is cached in memory, deliberately. The Keychain item is the only
/// copy: a token held in a property outlives the item it came from, and a
/// sibling app rotating that item to a different user's token is the S-H1
/// bug class that `OSNSession.reconcileIdentity()` exists to close.
///
/// Every method here is `@concurrent`, so the synchronous
/// `SecItemCopyMatching` inside runs on the concurrent executor even when
/// the caller is `@MainActor`. Without the attribute this holds only by the
/// current default for `nonisolated async` (SE-0338); turning on
/// `NonisolatedNonsendingByDefault`, or moving to a later language mode,
/// would silently put every Keychain read back on the main thread with the
/// whole suite still green.
public struct AccessTokenProvider: Sendable {
    /// A stored token within this many seconds of its `expiresAt` counts as
    /// already gone, so one is never sent moments before the server would
    /// reject it mid-flight. Access tokens live five minutes
    /// (`wiki/systems/identity-model.md`), so this is a clock-skew
    /// allowance, not a refresh schedule.
    public static let expirySkew: TimeInterval = 30

    private let tokenRefresher: TokenRefresher

    public init(tokenRefresher: TokenRefresher) {
        self.tokenRefresher = tokenRefresher
    }

    /// One Keychain read, off the caller's actor. `nil` means nothing is
    /// stored, which is the signed-out state and not an error.
    ///
    /// Exposed so `OSNSession` can make its own freshness decision without
    /// reading the Keychain on the main actor and without a second copy of
    /// the skew allowance.
    @concurrent
    public static func storedAccessToken() async throws -> KeychainAccessTokenStore.StoredAccessToken? {
        try KeychainAccessTokenStore.load()
    }

    /// The bearer token for one outgoing request, from exactly one Keychain
    /// read, treating an empty Keychain as a cold start: nothing is stored
    /// yet, but the session cookie may well be good, so refresh and carry
    /// on. `BearerTokenMiddleware`'s case — the Pulse client is built once at
    /// launch and its first call routinely mints the process's first access
    /// token.
    @concurrent
    public func bearerTokenRefreshingWhenAbsent() async throws -> ResolvedAccessToken {
        guard let stored = try KeychainAccessTokenStore.load() else {
            return ResolvedAccessToken(token: try await tokenRefresher.refresh().accessToken, wasJustMinted: true)
        }
        return try await resolve(stored)
    }

    /// The same single read, treating an empty Keychain as the signed-out
    /// state: `nil`, rather than a `/token` round trip with no session
    /// cookie to present. The `OSNAuth` clients' case, which surface it as
    /// `OSNAuthError.accessTokenMissing`.
    ///
    /// A token that *is* stored but sits within `expirySkew` of expiry is
    /// refreshed on this path too — being signed out and holding a stale
    /// token are different states and only the first is reported.
    @concurrent
    public func storedSessionBearerToken() async throws -> ResolvedAccessToken? {
        guard let stored = try KeychainAccessTokenStore.load() else { return nil }
        return try await resolve(stored)
    }

    /// The 401 path: a replacement for the token the server just rejected.
    ///
    /// Reads the Keychain once first, and hands back what it finds when that
    /// is a *different*, still-fresh token — a concurrent request that
    /// already refreshed has written the good one there, and reusing it
    /// avoids a second `/token` grant. Only when the stored token is still
    /// the rejected one does this refresh.
    ///
    /// That matters because every grant rotates the session cookie
    /// (`TokenRefresher`), and `refresh()` coalesces only calls that overlap
    /// in flight — several requests failing in a stagger would otherwise
    /// rotate the cookie once each. No second coalescer lives here: two of
    /// them racing on one cookie jar is the replayed-cookie reuse detection
    /// that PR #289 fixed on the web client.
    @concurrent
    public func refreshedBearerToken(replacing rejected: String) async throws -> String {
        if let stored = try KeychainAccessTokenStore.load(),
            stored.token != rejected,
            stored.expiresAt.timeIntervalSinceNow > Self.expirySkew
        {
            return stored.token
        }
        return try await tokenRefresher.refresh().accessToken
    }

    private func resolve(_ stored: KeychainAccessTokenStore.StoredAccessToken) async throws -> ResolvedAccessToken {
        if stored.expiresAt.timeIntervalSinceNow > Self.expirySkew {
            return ResolvedAccessToken(token: stored.token, wasJustMinted: false)
        }
        return ResolvedAccessToken(token: try await tokenRefresher.refresh().accessToken, wasJustMinted: true)
    }
}
