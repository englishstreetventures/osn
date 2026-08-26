import Foundation
import OSNKit
import OSNTesting
import Testing
@testable import OSNAuth

private func fixtureAssertion() -> AuthenticationResponseJSON {
    AuthenticationResponseJSON(
        id: "id",
        rawId: "rawId",
        authenticatorAttachment: "platform",
        response: AuthenticatorAssertionResponseJSON(
            clientDataJSON: "clientData",
            authenticatorData: "authData",
            signature: "sig",
            userHandle: nil
        )
    )
}

/// DoD 2: "access-token persistence after successful complete." Touches the
/// real Keychain via `KeychainAccessTokenStore`, so this shares the
/// cross-target serialized lock with `OSNKitTests/KeychainAccessTokenStoreTests.swift`
/// rather than running as an independent concurrent `@Test`.
@Suite(.serialized, .keychainSerializing)
struct PasskeyLoginClientCompleteTests {
    @Test func successfulCompletePersistsAccessTokenAndVerifiesCookie() async throws {
        try KeychainAccessTokenStore.delete()
        let environment = Environment.local
        let session = makeMockSession()
        let client = PasskeyLoginClient(session: session, environment: environment)

        MockURLProtocol.handler = { _ in
            let body = """
            {"session":{"access_token":"at-passkey-1","token_type":"Bearer","expires_in":300,"scope":"openid profile"},
             "profile":{"id":"u1","handle":"someone","email":"someone@example.com","displayName":null,"avatarUrl":null}}
            """
            return (
                200,
                ["Content-Type": "application/json", "Set-Cookie": "osn_session=rotated-passkey-1; Path=/"],
                Data(body.utf8)
            )
        }

        let response = try await client.complete(target: .identifier("someone"), assertion: fixtureAssertion())
        #expect(response.session.accessToken == "at-passkey-1")
        #expect(try KeychainAccessTokenStore.load()?.token == "at-passkey-1")

        let cookies = session.configuration.httpCookieStorage?.cookies(for: environment.baseURL) ?? []
        #expect(cookies.contains(where: { $0.name == "osn_session" }))

        try KeychainAccessTokenStore.delete()
    }

    @Test func completeWithoutRotatedCookieThrowsAndDoesNotPersist() async throws {
        try KeychainAccessTokenStore.delete()
        let environment = Environment.local
        let session = makeMockSession()
        let client = PasskeyLoginClient(session: session, environment: environment)

        MockURLProtocol.handler = { _ in
            let body = """
            {"session":{"access_token":"at-passkey-2","token_type":"Bearer","expires_in":300,"scope":"openid profile"},
             "profile":{"id":"u1","handle":"someone","email":"someone@example.com","displayName":null,"avatarUrl":null}}
            """
            return (200, ["Content-Type": "application/json"], Data(body.utf8))
        }

        await #expect(throws: OSNKitError.sessionCookieNotPersisted(name: "osn_session", host: "localhost")) {
            try await client.complete(target: .identifier("someone"), assertion: fixtureAssertion())
        }
    }
}
