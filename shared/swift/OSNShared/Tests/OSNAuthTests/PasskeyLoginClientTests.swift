import Foundation
import OSNKit
import OSNTesting
import Testing
@testable import OSNAuth

/// Intercepts requests for one `URLSession` at a time — mirrors
/// `OSNKitTests/TokenRefresherTests.swift`'s `MockURLProtocol`. Each test
/// target needs its own copy since `URLProtocol` subclasses aren't shared
/// across SPM targets.
final class LoginMockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) async throws -> (Int, [String: String], Data))?
    nonisolated(unsafe) static var cookieStorage: HTTPCookieStorage?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        Task {
            do {
                let (status, headers, data) = try await handler(request)
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: status,
                    httpVersion: "HTTP/1.1",
                    headerFields: headers
                )!
                if let url = request.url {
                    let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
                    if !cookies.isEmpty {
                        Self.cookieStorage?.setCookies(cookies, for: url, mainDocumentURL: nil)
                    }
                }
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        }
    }

    override func stopLoading() {}
}

private func makeTestSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [LoginMockURLProtocol.self]
    configuration.httpShouldSetCookies = true
    configuration.httpCookieAcceptPolicy = .always
    LoginMockURLProtocol.cookieStorage = configuration.httpCookieStorage
    return URLSession(configuration: configuration)
}

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
        let session = makeTestSession()
        let client = PasskeyLoginClient(session: session, environment: environment)

        LoginMockURLProtocol.handler = { _ in
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
        let session = makeTestSession()
        let client = PasskeyLoginClient(session: session, environment: environment)

        LoginMockURLProtocol.handler = { _ in
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
