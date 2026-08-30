import Foundation
import OSNKit
import OSNTesting
import Testing

@testable import OSNAuth

/// Neither `StepUpPasskeyClient.mintStepUpToken` nor
/// `PasskeyEnrollmentClient.register` can run here — both drive a real
/// `ASAuthorization` ceremony, which needs a presentation anchor and a user.
/// What is testable, and what this branch rewrote, is the half that talks to
/// the server: these suites drive those methods directly.
@Suite(.serialized, .keychainSerializing)
struct StepUpPasskeyClientTests {
    private static let beginBody = #"""
    {"options":{"challenge":"Y2g","timeout":60000,"rpId":"musubi.social",
     "allowCredentials":[{"id":"aWQ","type":"public-key"}],"userVerification":"required"}}
    """#

    private func makeClient(_ session: URLSession) -> StepUpPasskeyClient {
        StepUpPasskeyClient(
            session: session,
            environment: .local,
            tokenRefresher: TokenRefresher(session: session, environment: .local)
        )
    }

    @Test func beginPostsToTheStepUpRouteWithTheBearerToken() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-fresh", expiresIn: 300)

        let session = makeMockSession()
        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            return (200, ["Content-Type": "application/json"], Data(Self.beginBody.utf8))
        }

        let response = try await makeClient(session).begin()

        #expect(response.options.rpId == "musubi.social")
        #expect(response.options.userVerification == "required")
        #expect(await seen.last?.path == "/step-up/passkey/begin")
        #expect(await seen.last?.authorization == "Bearer looks-fresh")

        try KeychainAccessTokenStore.delete()
    }

    @Test func completeSendsThePurposeAndReturnsTheMintedToken() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-fresh", expiresIn: 300)

        let session = makeMockSession()
        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            return (
                200,
                ["Content-Type": "application/json"],
                Data(#"{"step_up_token":"su-1","expires_in":300}"#.utf8)
            )
        }

        let assertion = AuthenticationResponseJSON(
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
        let response = try await makeClient(session).complete(assertion: assertion, purpose: .passkeyDelete)

        #expect(response == StepUpPasskeyCompleteResponse(stepUpToken: "su-1", expiresIn: 300))
        #expect(await seen.last?.path == "/step-up/passkey/complete")
        let body = try #require(await seen.last?.body)
        #expect(String(decoding: body, as: UTF8.self).contains(#""purpose":"passkey_delete""#))

        try KeychainAccessTokenStore.delete()
    }
}

@Suite(.serialized, .keychainSerializing)
struct PasskeyEnrollmentClientTests {
    private static let optionsBody = #"""
    {"rp":{"id":"musubi.social","name":"Musubi"},
     "user":{"id":"dTE","name":"alice","displayName":"Alice"},
     "challenge":"Y2g","pubKeyCredParams":[{"type":"public-key","alg":-7}],
     "timeout":60000,"excludeCredentials":null,"authenticatorSelection":null,"attestation":null}
    """#

    private func makeClient(_ session: URLSession) -> PasskeyEnrollmentClient {
        PasskeyEnrollmentClient(
            session: session,
            environment: .local,
            tokenRefresher: TokenRefresher(session: session, environment: .local)
        )
    }

    /// The only conditional header in the package: present for a later
    /// passkey, absent for the account's first, where the server bypasses the
    /// step-up gate itself because no ceremony is reachable pre-credential.
    @Test(arguments: [("su-1", "su-1" as String?), (nil, nil)] as [(String?, String?)])
    func theStepUpHeaderIsSetOnlyWhenATokenIsSupplied(supplied: String?, expected: String?) async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-fresh", expiresIn: 300)

        let session = makeMockSession()
        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            return (200, ["Content-Type": "application/json"], Data(Self.optionsBody.utf8))
        }

        let options = try await makeClient(session)
            .beginRegistration(profileId: "profile-a", stepUpToken: supplied)

        #expect(options.rp.id == "musubi.social")
        #expect(await seen.last?.path == "/passkey/register/begin")
        #expect(await seen.last?.stepUpToken == expected)

        try KeychainAccessTokenStore.delete()
    }

    /// Both enrollment calls are Bearer-authed, and the same 401 retry covers
    /// them — including carrying the step-up header through unchanged.
    @Test func aRejectedTokenRetriesTheRegistrationBeginWithTheHeaderIntact() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-fresh", expiresIn: 300)

        let session = makeMockSession()
        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            if request.url?.path.hasSuffix("/token") == true {
                return (
                    200,
                    ["Content-Type": "application/json", "Set-Cookie": "osn_session=rotated-e; Path=/"],
                    Data(#"{"access_token":"rotated-token","token_type":"Bearer","expires_in":300,"scope":"openid"}"#.utf8)
                )
            }
            let attempts = await seen.values.filter { $0.path.hasSuffix("/begin") }.count
            if attempts == 1 {
                return (401, ["Content-Type": "application/json"], Data(#"{"error":"unauthorized"}"#.utf8))
            }
            return (200, ["Content-Type": "application/json"], Data(Self.optionsBody.utf8))
        }

        _ = try await makeClient(session).beginRegistration(profileId: "profile-a", stepUpToken: "su-1")

        #expect(await seen.values.map(\.path) == [
            "/passkey/register/begin", "/token", "/passkey/register/begin",
        ])
        #expect(await seen.values.compactMap(\.stepUpToken) == ["su-1", "su-1"])
        #expect(await seen.last?.authorization == "Bearer rotated-token")

        try KeychainAccessTokenStore.delete()
    }

    @Test func completeRegistrationReturnsTheNewCredentialId() async throws {
        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("looks-fresh", expiresIn: 300)

        let session = makeMockSession()
        let seen = Recorder<SeenRequest>()
        MockURLProtocol.handler = { request in
            await record(request, into: seen)
            return (200, ["Content-Type": "application/json"], Data(#"{"passkeyId":"pk_0123456789ab"}"#.utf8))
        }

        let attestation = RegistrationResponseJSON(
            id: "id",
            rawId: "rawId",
            authenticatorAttachment: "platform",
            response: AuthenticatorAttestationResponseJSON(
                clientDataJSON: "clientData",
                attestationObject: "attestation"
            )
        )
        let result = try await makeClient(session)
            .completeRegistration(profileId: "profile-a", attestation: attestation)

        #expect(result == PasskeyEnrollmentResult(passkeyId: "pk_0123456789ab"))
        #expect(await seen.last?.path == "/passkey/register/complete")

        try KeychainAccessTokenStore.delete()
    }
}
