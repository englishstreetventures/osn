import Foundation
import HTTPTypes
import OpenAPIRuntime
import OSNKit
import OSNTesting
import Testing

@testable import PulseAPI

private actor Counter {
    private(set) var value = 0
    func increment() { value += 1 }
}

/// `next` is `@Sendable`, so a plain `var` captured and mutated inside it is
/// a data race under Swift 6 strict concurrency even though every call here
/// is sequential — route the capture through an actor instead.
private actor Recorder<Value: Sendable> {
    private(set) var values: [Value] = []
    func record(_ value: Value) { values.append(value) }
    var last: Value? { values.last }
}

/// Shares the real Keychain access-token item with `OSNKitTests`'
/// `KeychainSerialTests` suite. `.serialized` only orders tests within this
/// suite; `.keychainSerializing` (from `OSNTesting`) additionally locks out
/// that other suite so the two never touch the Keychain item concurrently.
@Suite(.serialized, .keychainSerializing)
struct BearerTokenMiddlewareTests {
    @Test func expiredTokenTriggersRefresh() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("stale-token", expiresIn: -10)

        let session = makeMockSession()
        let refresher = TokenRefresher(session: session, environment: .local)
        let middleware = BearerTokenMiddleware(tokenRefresher: refresher)

        MockURLProtocol.handler = { _ in
            let body = #"{"access_token":"fresh-token","token_type":"Bearer","expires_in":300,"scope":"openid profile"}"#
            return (
                200,
                ["Content-Type": "application/json", "Set-Cookie": "osn_session=rotated-1; Path=/"],
                Data(body.utf8)
            )
        }

        let seenAuthorization = Recorder<String?>()
        let (response, body) = try await middleware.intercept(
            HTTPRequest(method: .get, scheme: "https", authority: "localhost", path: "/events"),
            body: nil,
            baseURL: URL(string: "http://localhost:4000")!,
            operationID: "listEvents"
        ) { request, _, _ in
            await seenAuthorization.record(request.headerFields[.authorization])
            return (HTTPResponse(status: .ok), nil)
        }

        #expect(await seenAuthorization.last == "Bearer fresh-token")
        #expect(response.status.code == 200)
        #expect(body == nil)
        #expect(try KeychainAccessTokenStore.load()?.token == "fresh-token")
    }

    @Test func validTokenSkipsRefresh() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("valid-token", expiresIn: 300)

        let session = makeMockSession()
        let refresher = TokenRefresher(session: session, environment: .local)
        let middleware = BearerTokenMiddleware(tokenRefresher: refresher)

        // No handler installed — a refresh call would crash the test by
        // hitting `didFailWithError`, proving the cached token was used.
        MockURLProtocol.handler = nil

        let seenAuthorization = Recorder<String?>()
        _ = try await middleware.intercept(
            HTTPRequest(method: .get, scheme: "https", authority: "localhost", path: "/events"),
            body: nil,
            baseURL: URL(string: "http://localhost:4000")!,
            operationID: "listEvents"
        ) { request, _, _ in
            await seenAuthorization.record(request.headerFields[.authorization])
            return (HTTPResponse(status: .ok), nil)
        }

        #expect(await seenAuthorization.last == "Bearer valid-token")
    }

    @Test func retriesOnceOn401() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-valid", expiresIn: 300)

        let session = makeMockSession()
        let refresher = TokenRefresher(session: session, environment: .local)
        let middleware = BearerTokenMiddleware(tokenRefresher: refresher)

        MockURLProtocol.handler = { _ in
            let body = #"{"access_token":"rotated-token","token_type":"Bearer","expires_in":300,"scope":"openid profile"}"#
            return (
                200,
                ["Content-Type": "application/json", "Set-Cookie": "osn_session=rotated-2; Path=/"],
                Data(body.utf8)
            )
        }

        let nextCallCount = Counter()
        let authorizationsSeen = Recorder<String>()
        let (response, _) = try await middleware.intercept(
            HTTPRequest(method: .get, scheme: "https", authority: "localhost", path: "/events"),
            body: nil,
            baseURL: URL(string: "http://localhost:4000")!,
            operationID: "listEvents"
        ) { request, _, _ in
            await nextCallCount.increment()
            let count = await nextCallCount.value
            await authorizationsSeen.record(request.headerFields[.authorization] ?? "")
            if count == 1 {
                return (HTTPResponse(status: .unauthorized), nil)
            }
            return (HTTPResponse(status: .ok), nil)
        }

        #expect(response.status.code == 200)
        #expect(await nextCallCount.value == 2)
        #expect(await authorizationsSeen.values == ["Bearer looks-valid", "Bearer rotated-token"])
    }

    @Test func doesNotRetryWhenTheBodyCannotBeReplayed() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-valid", expiresIn: 300)

        let session = makeMockSession()
        let refresher = TokenRefresher(session: session, environment: .local)
        let middleware = BearerTokenMiddleware(tokenRefresher: refresher)

        // A body built from an async sequence of unknown length is `.single`:
        // consumed by the first attempt, so a replay would trap.
        let singleUseBody = HTTPBody(
            AsyncStream<ArraySlice<UInt8>> { continuation in
                continuation.yield(ArraySlice(Data("{}".utf8)))
                continuation.finish()
            },
            length: .unknown
        )
        #expect(singleUseBody.iterationBehavior == .single)

        let nextCallCount = Counter()
        let (response, _) = try await middleware.intercept(
            HTTPRequest(method: .post, scheme: "https", authority: "localhost", path: "/events"),
            body: singleUseBody,
            baseURL: URL(string: "http://localhost:4000")!,
            operationID: "createEvent"
        ) { _, _, _ in
            await nextCallCount.increment()
            return (HTTPResponse(status: .unauthorized), nil)
        }

        #expect(response.status.code == 401)
        #expect(await nextCallCount.value == 1)
    }
}
