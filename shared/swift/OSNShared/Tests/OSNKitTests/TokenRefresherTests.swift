import Foundation
import OSNTesting
import Testing
@testable import OSNKit

extension KeychainSerialTests {
    // Also saves/deletes the real Keychain item (via TokenRefresher's calls
    // into KeychainAccessTokenStore) — lives in this serialized suite for
    // the same reason as keychainAccessTokenStoreRoundTrips above.
    @Test func tokenRefresherScenarios() async throws {
    try KeychainAccessTokenStore.delete()
    let environment = Environment.local
    let session = makeMockSession()
    let refresher = TokenRefresher(session: session, environment: environment)

    // 1. Success: decodes the grant, persists the rotated cookie, saves the
    // access token to the Keychain.
    MockURLProtocol.handler = { _ in
        let body = #"{"access_token":"at-1","token_type":"Bearer","expires_in":300,"scope":"openid profile"}"#
        return (
            200,
            ["Content-Type": "application/json", "Set-Cookie": "osn_session=rotated-1; Path=/"],
            Data(body.utf8)
        )
    }
    let grant = try await refresher.refresh()
    #expect(grant.accessToken == "at-1")
    #expect(grant.tokenType == "Bearer")
    #expect(grant.expiresIn == 300)
    #expect(grant.scope == "openid profile")
    #expect(try KeychainAccessTokenStore.load()?.token == "at-1")
    let cookies = session.configuration.httpCookieStorage?.cookies(for: environment.baseURL) ?? []
    #expect(cookies.contains(where: { $0.name == "osn_session" }))

    // 2. 400 unsupported_grant_type.
    MockURLProtocol.handler = { _ in
        (400, ["Content-Type": "application/json"], Data(#"{"error":"unsupported_grant_type"}"#.utf8))
    }
    await #expect(throws: OSNKitError.refreshUnsupportedGrantType) {
        try await refresher.refresh()
    }

    // 3. 400 invalid_request — cookie never arrived, a jar bug not an auth failure.
    MockURLProtocol.handler = { _ in
        (400, ["Content-Type": "application/json"], Data(#"{"error":"invalid_request"}"#.utf8))
    }
    await #expect(throws: OSNKitError.refreshCookieMissing) {
        try await refresher.refresh()
    }

    // 4. 400 invalid_grant — session is gone, message carried through.
    MockURLProtocol.handler = { _ in
        (400, ["Content-Type": "application/json"], Data(#"{"error":"invalid_grant","message":"session revoked"}"#.utf8))
    }
    await #expect(throws: OSNKitError.refreshSessionInvalid(message: "session revoked")) {
        try await refresher.refresh()
    }

    // 5. 200 with an undecodable body — never treated as success.
    MockURLProtocol.handler = { _ in
        (200, ["Content-Type": "application/json"], Data("not json".utf8))
    }
    await #expect(throws: OSNKitError.refreshResponseMalformed(status: 200)) {
        try await refresher.refresh()
    }

    // 6. Door 1: 200, valid body, but no Set-Cookie actually landed in the jar.
    // Scenario 1's cookie is still in the jar from the prior request — clear
    // it first, otherwise the presence check below passes on stale state
    // instead of catching this response's missing Set-Cookie.
    for cookie in session.configuration.httpCookieStorage?.cookies(for: environment.baseURL) ?? [] {
        session.configuration.httpCookieStorage?.deleteCookie(cookie)
    }
    MockURLProtocol.handler = { _ in
        let body = #"{"access_token":"at-2","token_type":"Bearer","expires_in":300,"scope":"openid profile"}"#
        return (200, ["Content-Type": "application/json"], Data(body.utf8))
    }
    await #expect(throws: OSNKitError.sessionCookieNotPersisted(name: "osn_session", host: "localhost")) {
        try await refresher.refresh()
    }
    // The failed attempt above must not have overwritten the Keychain.
    #expect(try KeychainAccessTokenStore.load()?.token == "at-1")

    // 7. Single-flight: two concurrent refreshes collapse into one request.
    let callCount = Counter()
    MockURLProtocol.handler = { _ in
        await callCount.increment()
        try? await Task.sleep(nanoseconds: 50_000_000)
        let body = #"{"access_token":"at-3","token_type":"Bearer","expires_in":300,"scope":"openid profile"}"#
        return (
            200,
            ["Content-Type": "application/json", "Set-Cookie": "osn_session=rotated-3; Path=/"],
            Data(body.utf8)
        )
    }
    async let first = refresher.refresh()
    async let second = refresher.refresh()
    let (firstGrant, secondGrant) = try await (first, second)
    #expect(firstGrant == secondGrant)
    #expect(await callCount.value == 1)

    // 8. Logout clears the cached access token.
    MockURLProtocol.handler = { _ in (200, ["Content-Type": "application/json"], Data(#"{"success":true}"#.utf8)) }
    try await refresher.logout()
    #expect(try KeychainAccessTokenStore.load() == nil)
    }
}

private actor Counter {
    private(set) var value = 0
    func increment() { value += 1 }
}
