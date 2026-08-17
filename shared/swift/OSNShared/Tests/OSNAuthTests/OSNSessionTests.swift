import Foundation
import OSNKit
import OSNTesting
import Testing
@testable import OSNAuth

private func makeMockSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [LoginMockURLProtocol.self]
    configuration.httpShouldSetCookies = true
    configuration.httpCookieAcceptPolicy = .always
    LoginMockURLProtocol.cookieStorage = configuration.httpCookieStorage
    return URLSession(configuration: configuration)
}

@MainActor
private func makeOSNSession(environment: Environment, session: URLSession, tokenRefresher: TokenRefresher) -> OSNSession {
    OSNSession(
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

        LoginMockURLProtocol.handler = { _ in
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

        LoginMockURLProtocol.handler = { _ in
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
        LoginMockURLProtocol.handler = { _ in
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
        LoginMockURLProtocol.handler = { _ in
            await requestCount.increment()
            return (200, [:], Data())
        }

        let osnSession = await makeOSNSession(environment: environment, session: session, tokenRefresher: tokenRefresher)
        try await osnSession.ensureFreshAccessToken()
        #expect(await requestCount.value == 0)

        try KeychainAccessTokenStore.delete()
    }
}

private actor Counter {
    private(set) var value = 0
    func increment() { value += 1 }
}
