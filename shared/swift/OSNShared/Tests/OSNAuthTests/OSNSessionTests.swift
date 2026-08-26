import Foundation
import OSNKit
import OSNTesting
import Testing
@testable import OSNAuth

/// Same fixture-building approach as `AccessTokenClaimsTests` — real header/
/// payload JSON through `Base64URL.encode`, not an opaque literal blob.
private func makeJWT(sub: String, email: String, handle: String, displayName: String?) -> String {
    let header = Base64URL.encode(Data(#"{"alg":"ES256","typ":"JWT"}"#.utf8))
    var payloadObject = ["sub": sub, "email": email, "handle": handle]
    if let displayName {
        payloadObject["displayName"] = displayName
    }
    let payloadData = try! JSONSerialization.data(withJSONObject: payloadObject)
    let payload = Base64URL.encode(payloadData)
    let signature = Base64URL.encode(Data([0x01, 0x02, 0x03]))
    return "\(header).\(payload).\(signature)"
}

@MainActor
private func makeOSNSession(environment: Environment, session: URLSession, tokenRefresher: TokenRefresher) -> OSNSession {
    OSNSession(
        environment: environment,
        urlSession: session,
        tokenRefresher: tokenRefresher,
        loginClient: PasskeyLoginClient(session: session, environment: environment)
    )
}

/// Touches the real Keychain via `KeychainAccessTokenStore`/`TokenRefresher`,
/// so shares the cross-target serialized lock with
/// `OSNKitTests/KeychainAccessTokenStoreTests.swift` and
/// `PasskeyLoginClientTests.swift` rather than running independently.
@Suite(.serialized, .keychainSerializing)
@MainActor
struct OSNSessionTests {
    @Test func failingRefreshLeavesStateSignedOutNeverFailed() async throws {
        try KeychainAccessTokenStore.delete()
        let environment = Environment.local
        let session = makeMockSession()
        let tokenRefresher = TokenRefresher(session: session, environment: environment)

        MockURLProtocol.handler = { _ in
            let body = #"{"error":"invalid_grant","message":"session expired"}"#
            return (400, ["Content-Type": "application/json"], Data(body.utf8))
        }

        let osnSession = await makeOSNSession(environment: environment, session: session, tokenRefresher: tokenRefresher)
        await osnSession.restore()
        #expect(osnSession.state == .signedOut)
    }

    @Test func signOutClearsKeychainAccessToken() async throws {
        try KeychainAccessTokenStore.save("token-to-clear", expiresIn: 300)
        #expect(try KeychainAccessTokenStore.load() != nil)

        let environment = Environment.local
        let session = makeMockSession()
        let tokenRefresher = TokenRefresher(session: session, environment: environment)

        MockURLProtocol.handler = { _ in
            (200, [:], Data())
        }

        let osnSession = await makeOSNSession(environment: environment, session: session, tokenRefresher: tokenRefresher)
        await osnSession.signOut()

        #expect(try KeychainAccessTokenStore.load() == nil)
        #expect(osnSession.state == .signedOut)
    }

    @Test func ensureFreshAccessTokenRefreshesWhenMissingOrExpiring() async throws {
        try KeychainAccessTokenStore.delete()
        let environment = Environment.local
        let session = makeMockSession()
        let tokenRefresher = TokenRefresher(session: session, environment: environment)

        let requestCount = Counter()
        MockURLProtocol.handler = { _ in
            await requestCount.increment()
            let body = """
            {"access_token":"at-fresh-1","token_type":"Bearer","expires_in":300,"scope":"openid profile"}
            """
            return (
                200,
                ["Content-Type": "application/json", "Set-Cookie": "osn_session=rotated-fresh-1; Path=/"],
                Data(body.utf8)
            )
        }

        let osnSession = await makeOSNSession(environment: environment, session: session, tokenRefresher: tokenRefresher)

        // Missing token: must refresh.
        try await osnSession.ensureFreshAccessToken()
        #expect(await requestCount.value == 1)

        // Expiring inside the next 30 seconds: must refresh again.
        try KeychainAccessTokenStore.save("token-about-to-expire", expiresIn: 5)
        try await osnSession.ensureFreshAccessToken()
        #expect(await requestCount.value == 2)

        try KeychainAccessTokenStore.delete()
    }

    @Test func ensureFreshAccessTokenDoesNotRefreshWhenFresh() async throws {
        try KeychainAccessTokenStore.save("token-still-fresh", expiresIn: 300)
        let environment = Environment.local
        let session = makeMockSession()
        let tokenRefresher = TokenRefresher(session: session, environment: environment)

        let requestCount = Counter()
        MockURLProtocol.handler = { _ in
            await requestCount.increment()
            return (200, [:], Data())
        }

        let osnSession = await makeOSNSession(environment: environment, session: session, tokenRefresher: tokenRefresher)
        try await osnSession.ensureFreshAccessToken()
        #expect(await requestCount.value == 0)

        try KeychainAccessTokenStore.delete()
    }

    /// S-H1 end to end: session is showing A's profile, then the Keychain
    /// token it shares with a sibling app (same cookie jar, same slot) is
    /// swapped out from under it to one whose `sub` is B — without this app
    /// ever calling `signIn`/`signOut`/`restore` again. `ensureFreshAccessToken()`
    /// is the seam every authenticated call goes through, so it must be what
    /// catches this: state ends at `.signedIn(B)`, never `.signedIn(A)`.
    @Test func ensureFreshAccessTokenReflectsKeychainTokenSwapToADifferentUser() async throws {
        try KeychainAccessTokenStore.delete()
        let environment = Environment.local
        let session = makeMockSession()
        let tokenRefresher = TokenRefresher(session: session, environment: environment)

        let jwtA = makeJWT(sub: "profile-a", email: "a@example.com", handle: "alice", displayName: "Alice")
        MockURLProtocol.handler = { _ in
            let body = """
            {"access_token":"\(jwtA)","token_type":"Bearer","expires_in":300,"scope":"openid profile"}
            """
            return (
                200,
                ["Content-Type": "application/json", "Set-Cookie": "osn_session=rotated-a; Path=/"],
                Data(body.utf8)
            )
        }

        let osnSession = await makeOSNSession(environment: environment, session: session, tokenRefresher: tokenRefresher)
        await osnSession.restore()
        guard case .signedIn(let profileA) = osnSession.state, profileA?.id == "profile-a" else {
            Issue.record("expected .signedIn(profile-a) after restore, got \(osnSession.state)")
            try KeychainAccessTokenStore.delete()
            return
        }

        // A sibling app (Pulse) rotates the shared Keychain slot to B's token
        // — this session is never told directly, and never calls signIn/
        // signOut/restore again.
        let jwtB = makeJWT(sub: "profile-b", email: "b@example.com", handle: "bob", displayName: "Bob")
        try KeychainAccessTokenStore.save(jwtB, expiresIn: 300)

        try await osnSession.ensureFreshAccessToken()

        guard case .signedIn(let profileB) = osnSession.state else {
            Issue.record("expected .signedIn after ensureFreshAccessToken, got \(osnSession.state)")
            try KeychainAccessTokenStore.delete()
            return
        }
        #expect(profileB?.id == "profile-b")
        #expect(osnSession.state != .signedIn(profileA))

        try KeychainAccessTokenStore.delete()
    }

    /// Second half of the S-H1 fix: the Keychain token is not a JWT at all
    /// (corrupted, or some future non-JWT credential). `reconciledProfile`
    /// fails closed on undecodable claims, so state must drop to
    /// `.signedIn(nil)` rather than keep showing A's now-untrustworthy
    /// cached profile.
    @Test func ensureFreshAccessTokenDropsToNilProfileWhenKeychainTokenIsNotAJWT() async throws {
        try KeychainAccessTokenStore.delete()
        let environment = Environment.local
        let session = makeMockSession()
        let tokenRefresher = TokenRefresher(session: session, environment: environment)

        let jwtA = makeJWT(sub: "profile-a", email: "a@example.com", handle: "alice", displayName: "Alice")
        MockURLProtocol.handler = { _ in
            let body = """
            {"access_token":"\(jwtA)","token_type":"Bearer","expires_in":300,"scope":"openid profile"}
            """
            return (
                200,
                ["Content-Type": "application/json", "Set-Cookie": "osn_session=rotated-a2; Path=/"],
                Data(body.utf8)
            )
        }

        let osnSession = await makeOSNSession(environment: environment, session: session, tokenRefresher: tokenRefresher)
        await osnSession.restore()
        guard case .signedIn(let profileA) = osnSession.state, profileA?.id == "profile-a" else {
            Issue.record("expected .signedIn(profile-a) after restore, got \(osnSession.state)")
            try KeychainAccessTokenStore.delete()
            return
        }

        try KeychainAccessTokenStore.save("not-a-jwt-token", expiresIn: 300)

        try await osnSession.ensureFreshAccessToken()

        #expect(osnSession.state == .signedIn(nil))

        try KeychainAccessTokenStore.delete()
    }
}

private actor Counter {
    private(set) var value = 0
    func increment() { value += 1 }
}
