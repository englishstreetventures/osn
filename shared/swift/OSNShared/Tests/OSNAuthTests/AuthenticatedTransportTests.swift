import Foundation
import OSNKit
import OSNTesting
import Testing

@testable import OSNAuth

private let tokenGrantBody = #"""
{"access_token":"rotated-token","token_type":"Bearer","expires_in":300,"scope":"openid profile"}
"""#

private func tokenGrantResponse() -> (Int, [String: String], Data) {
    (
        200,
        ["Content-Type": "application/json", "Set-Cookie": "osn_session=rotated-1; Path=/"],
        Data(tokenGrantBody.utf8)
    )
}

private let passkeyListBody = #"""
{"passkeys":[{"id":"pk_0123456789ab","label":"iPhone","aaguid":null,"transports":null,
 "backupEligible":null,"backupState":null,"createdAt":1,"lastUsedAt":null}]}
"""#

private func makeClient(_ session: URLSession, _ environment: Environment) -> PasskeyManagementClient {
    PasskeyManagementClient(
        session: session,
        environment: environment,
        tokenRefresher: TokenRefresher(session: session, environment: environment)
    )
}

/// The 401 retry, the single Keychain read, the error mapping and the shared
/// skew allowance, all driven through a real client rather than the transport
/// directly — the point of the change is that every `OSNAuth` client gets this
/// without asking, and a test that reached past them could not show that.
///
/// Touches the real Keychain, so it carries `.keychainSerializing` like every
/// other suite that drives `MockURLProtocol` — see that type's doc.
@Suite(.serialized, .keychainSerializing)
struct AuthenticatedTransportTests {
    @Test func aRejectedAccessTokenIsRefreshedAndTheRequestRetriedOnce() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-fresh", expiresIn: 300)

        let session = makeMockSession()
        let client = makeClient(session, .local)

        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            if request.url?.path.hasSuffix("/token") == true {
                return tokenGrantResponse()
            }
            let attempts = await seen.values.filter { $0.path.hasSuffix("/passkeys") }.count
            if attempts == 1 {
                return (401, ["Content-Type": "application/json"], Data(#"{"error":"unauthorized"}"#.utf8))
            }
            return (200, ["Content-Type": "application/json"], Data(passkeyListBody.utf8))
        }

        let passkeys = try await client.list()

        #expect(passkeys.map(\.id) == ["pk_0123456789ab"])
        #expect(
            await seen.values.map(\.path) == ["/passkeys", "/token", "/passkeys"],
            "a 401 refreshes once, then replays the same request"
        )
        #expect(await seen.values.map(\.authorization) == [
            "Bearer looks-fresh", nil, "Bearer rotated-token",
        ])
        #expect(try KeychainAccessTokenStore.load()?.token == "rotated-token")

        try KeychainAccessTokenStore.delete()
    }

    @Test func aSecondUnauthorizedIsReportedRatherThanRetriedAgain() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-fresh", expiresIn: 300)

        let session = makeMockSession()
        let client = makeClient(session, .local)

        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            if request.url?.path.hasSuffix("/token") == true {
                return tokenGrantResponse()
            }
            return (401, ["Content-Type": "application/json"], Data(#"{"error":"unauthorized"}"#.utf8))
        }

        await #expect(throws: OSNAuthError.requestFailed(status: 401, error: "unauthorized")) {
            _ = try await client.list()
        }
        #expect(
            await seen.values.map(\.path) == ["/passkeys", "/token", "/passkeys"],
            "exactly one retry — `TokenRefresher` is the only thing that can mint a token and it has had its turn"
        )

        try KeychainAccessTokenStore.delete()
    }

    /// The retry resends the single-use `X-Step-Up-Token`, which is only safe
    /// because the server resolves the bearer principal and 401s *before* it
    /// verifies step-up (`osn/api/src/routes/auth/passkey-management.ts:140`),
    /// so the first attempt never consumed the token's jti.
    @Test func theStepUpTokenIsResentUnchangedOnTheRetry() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-fresh", expiresIn: 300)

        let session = makeMockSession()
        let client = makeClient(session, .local)

        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            if request.url?.path.hasSuffix("/token") == true {
                return tokenGrantResponse()
            }
            let attempts = await seen.values.filter { $0.path.contains("pk_") }.count
            if attempts == 1 {
                return (401, ["Content-Type": "application/json"], Data(#"{"error":"unauthorized"}"#.utf8))
            }
            return (200, ["Content-Type": "application/json"], Data(#"{"success":true,"remaining":2}"#.utf8))
        }

        let result = try await client.delete(id: "pk_0123456789ab", stepUpToken: "step-up-1")

        #expect(result == PasskeyDeleteResult(success: true, remaining: 2))
        #expect(await seen.values.compactMap(\.stepUpToken) == ["step-up-1", "step-up-1"])

        try KeychainAccessTokenStore.delete()
    }

    /// A token minted inside this very call is not worth retrying: a server
    /// that rejects the token it just issued will reject its replacement too.
    @Test func aTokenMintedDuringThisCallIsNotRetried() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("about-to-expire", expiresIn: 5)

        let session = makeMockSession()
        let client = makeClient(session, .local)

        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            if request.url?.path.hasSuffix("/token") == true {
                return tokenGrantResponse()
            }
            return (401, ["Content-Type": "application/json"], Data(#"{"error":"unauthorized"}"#.utf8))
        }

        await #expect(throws: OSNAuthError.requestFailed(status: 401, error: "unauthorized")) {
            _ = try await client.list()
        }
        #expect(
            await seen.values.map(\.path) == ["/token", "/passkeys"],
            "one refresh to resolve the expiring token, then no second one for the 401 it still got"
        )

        try KeychainAccessTokenStore.delete()
    }

    /// A concurrent request that already refreshed has written the good token
    /// to the Keychain, so the 401 path reuses it rather than spending another
    /// `/token` grant — every grant rotates the shared session cookie.
    @Test func aNewerStoredTokenIsReusedInsteadOfRefreshingAgain() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-fresh", expiresIn: 300)

        let session = makeMockSession()
        let client = makeClient(session, .local)

        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            let attempts = await seen.count
            if attempts == 1 {
                // Stand in for a sibling request that refreshed between our
                // resolve and our 401.
                try KeychainAccessTokenStore.save("someone-elses-refresh", expiresIn: 300)
                return (401, ["Content-Type": "application/json"], Data(#"{"error":"unauthorized"}"#.utf8))
            }
            return (200, ["Content-Type": "application/json"], Data(passkeyListBody.utf8))
        }

        _ = try await client.list()

        #expect(await seen.values.map(\.path) == ["/passkeys", "/passkeys"], "no `/token` request at all")
        #expect(await seen.last?.authorization == "Bearer someone-elses-refresh")

        try KeychainAccessTokenStore.delete()
    }

    @Test func nothingStoredIsReportedWithoutSendingARequest() async throws {
        try KeychainAccessTokenStore.delete()

        let session = makeMockSession()
        let client = makeClient(session, .local)

        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            return (200, [:], Data())
        }

        await #expect(throws: OSNAuthError.accessTokenMissing) {
            _ = try await client.list()
        }
        #expect(
            await seen.count == 0,
            "signed out is not a cold start: no `/token` round trip with no session cookie to spend"
        )
    }

    /// The other half of the fix: a stored token inside the skew allowance is
    /// replaced *before* the request, so the 401 path is a backstop rather
    /// than the normal way an expiring token gets renewed.
    ///
    /// Fixtures are absolute, and the constant is asserted outright. Writing
    /// them as `expirySkew - 5` would move with the constant and pass even at
    /// `expirySkew = 0`, which is the value the allowance exists to rule out.
    @Test func theSkewAllowanceIsThirtySecondsAndBracketsTheDecision() async throws {
        #expect(AccessTokenProvider.expirySkew == 30)

        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("about-to-expire", expiresIn: 25)

        let session = makeMockSession()
        let client = makeClient(session, .local)

        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            if request.url?.path.hasSuffix("/token") == true {
                return tokenGrantResponse()
            }
            return (200, ["Content-Type": "application/json"], Data(passkeyListBody.utf8))
        }

        _ = try await client.list()
        #expect(await seen.values.map(\.path) == ["/token", "/passkeys"], "25s is inside the allowance")
        #expect(await seen.last?.authorization == "Bearer rotated-token")

        // 45s is outside it: the stored token goes out untouched.
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("still-good", expiresIn: 45)
        let secondSeen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: secondSeen)
            return (200, ["Content-Type": "application/json"], Data(passkeyListBody.utf8))
        }

        _ = try await client.list()
        #expect(await secondSeen.values.map(\.path) == ["/passkeys"], "45s is outside the allowance")
        #expect(await secondSeen.last?.authorization == "Bearer still-good")

        try KeychainAccessTokenStore.delete()
    }

    /// The two codes the management endpoints document by name, plus the
    /// catch-all. Each asserts one request as well, since only a 401 retries.
    @Test(arguments: [
        (403, #"{"error":"step_up_required"}"#, OSNAuthError.stepUpRequired),
        (409, #"{"error":"session_stale","message":"Re-authenticate and try again."}"#,
         OSNAuthError.sessionStale(message: "Re-authenticate and try again.")),
        (500, #"{"error":"server_error"}"#, OSNAuthError.requestFailed(status: 500, error: "server_error")),
    ])
    func aNon401FailureIsMappedAndNeverRetried(status: Int, body: String, expected: OSNAuthError) async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-fresh", expiresIn: 300)

        let session = makeMockSession()
        let client = makeClient(session, .local)

        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            return (status, ["Content-Type": "application/json"], Data(body.utf8))
        }

        await #expect(throws: expected) {
            _ = try await client.delete(id: "pk_0123456789ab", stepUpToken: "step-up-1")
        }
        #expect(await seen.count == 1, "only a 401 is retried")

        try KeychainAccessTokenStore.delete()
    }

    @Test func aTwoHundredThatDoesNotDecodeIsMalformedNotAFailure() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-fresh", expiresIn: 300)

        let session = makeMockSession()
        let client = makeClient(session, .local)

        MockURLProtocol.handler = { _ in
            (200, ["Content-Type": "application/json"], Data("not json".utf8))
        }

        await #expect(throws: OSNAuthError.responseMalformed(status: 200)) {
            _ = try await client.list()
        }

        try KeychainAccessTokenStore.delete()
    }

    /// `rename` is the one method where a successful HTTP call can still
    /// throw — the server answers a bare `{ "success": … }`, so a `false`
    /// there is the only signal that the rename did not take.
    @Test func renameSendsTheLabelAndReportsAnUnsuccessfulBody() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-fresh", expiresIn: 300)

        let session = makeMockSession()
        let client = makeClient(session, .local)

        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            return (200, ["Content-Type": "application/json"], Data(#"{"success":true}"#.utf8))
        }

        try await client.rename(id: "pk_0123456789ab", label: "Work phone", stepUpToken: "step-up-1")
        #expect(await seen.last?.stepUpToken == "step-up-1")
        #expect(await seen.last.flatMap(\.body).map { String(decoding: $0, as: UTF8.self) } == #"{"label":"Work phone"}"#)

        MockURLProtocol.handler = { _ in
            (200, ["Content-Type": "application/json"], Data(#"{"success":false}"#.utf8))
        }
        await #expect(throws: OSNAuthError.responseMalformed(status: 200)) {
            try await client.rename(id: "pk_0123456789ab", label: "Work phone", stepUpToken: "step-up-1")
        }

        try KeychainAccessTokenStore.delete()
    }

    /// Parity with `BearerTokenMiddlewareTests.doesNotRetryWhenTheBodyCannotBeReplayed`:
    /// a streamed body is consumed by the first attempt, so the 401 comes
    /// back rather than a retry that would send nothing.
    @Test func aStreamedBodyIsNotReplayed() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-fresh", expiresIn: 300)

        let session = makeMockSession()
        let transport = AuthenticatedTransport(
            session: session,
            environment: .local,
            tokenRefresher: TokenRefresher(session: session, environment: .local)
        )

        var request = URLRequest(url: Environment.local.baseURL.appendingPathComponent("passkeys"))
        request.httpMethod = "POST"
        request.httpBodyStream = InputStream(data: Data("{}".utf8))

        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            return (401, ["Content-Type": "application/json"], Data(#"{"error":"unauthorized"}"#.utf8))
        }

        await #expect(throws: OSNAuthError.requestFailed(status: 401, error: "unauthorized")) {
            _ = try await transport.data(for: request)
        }
        #expect(await seen.count == 1)

        try KeychainAccessTokenStore.delete()
    }
}
