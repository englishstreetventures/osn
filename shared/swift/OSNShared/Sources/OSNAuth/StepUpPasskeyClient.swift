import AuthenticationServices
import Foundation
import OSNKit

/// `POST /step-up/passkey/begin` + `/complete` (brief §4) — mints a
/// short-lived step-up token for `X-Step-Up-Token` on management calls.
/// OTP step-up (`step-up.ts:105`, `:135`) is web-only fallback and out of
/// scope here (brief §4).
public final class StepUpPasskeyClient: Sendable {
    private let session: URLSession
    private let environment: Environment

    public init(session: URLSession, environment: Environment) {
        self.session = session
        self.environment = environment
    }

    @MainActor
    public func mintStepUpToken(
        purpose: StepUpPurpose,
        anchorProvider: @escaping PresentationAnchorProvider
    ) async throws -> StepUpPasskeyCompleteResponse {
        let begun = try await begin()
        let options = begun.options

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options.rpId)
        guard let challenge = Base64URL.decode(options.challenge) else {
            throw OSNAuthError.responseMalformed(status: 200)
        }
        let assertionRequest = provider.createCredentialAssertionRequest(challenge: challenge)
        assertionRequest.allowedCredentials = try options.allowCredentials.map { credential in
            guard let id = Base64URL.decode(credential.id) else {
                throw OSNAuthError.responseMalformed(status: 200)
            }
            return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: id)
        }
        if let preference = RequestHelpers.userVerificationPreference(from: options.userVerification) {
            assertionRequest.userVerificationPreference = preference
        }

        let authorization = try await PasskeyCeremony.perform(
            requests: [assertionRequest],
            anchorProvider: anchorProvider
        )
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw OSNAuthError.unexpectedCredentialType
        }

        let assertion = AuthenticationResponseJSON(
            id: Base64URL.encode(credential.credentialID),
            rawId: Base64URL.encode(credential.credentialID),
            authenticatorAttachment: "platform",
            response: AuthenticatorAssertionResponseJSON(
                clientDataJSON: Base64URL.encode(credential.rawClientDataJSON),
                authenticatorData: Base64URL.encode(credential.rawAuthenticatorData),
                signature: Base64URL.encode(credential.signature),
                userHandle: credential.userID.map(Base64URL.encode)
            )
        )

        return try await complete(assertion: assertion, purpose: purpose)
    }

    private func begin() async throws -> StepUpPasskeyBeginResponse {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("step-up/passkey/begin"))
        request.httpMethod = "POST"
        try RequestHelpers.applyBearerAccessToken(to: &request)

        let (data, response) = try await session.data(for: request)
        let http = try Self.httpResponse(response)
        guard http.statusCode == 200 else {
            throw RequestHelpers.opaqueFailure(status: http.statusCode, data: data)
        }
        guard let decoded = try? JSONDecoder().decode(StepUpPasskeyBeginResponse.self, from: data) else {
            throw OSNAuthError.responseMalformed(status: http.statusCode)
        }
        return decoded
    }

    private func complete(
        assertion: AuthenticationResponseJSON,
        purpose: StepUpPurpose
    ) async throws -> StepUpPasskeyCompleteResponse {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("step-up/passkey/complete"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        try RequestHelpers.applyBearerAccessToken(to: &request)
        request.httpBody = try JSONEncoder().encode(
            StepUpPasskeyCompleteRequestBody(assertion: assertion, purpose: purpose)
        )

        let (data, response) = try await session.data(for: request)
        let http = try Self.httpResponse(response)
        guard http.statusCode == 200 else {
            throw RequestHelpers.opaqueFailure(status: http.statusCode, data: data)
        }
        guard let decoded = try? JSONDecoder().decode(StepUpPasskeyCompleteResponse.self, from: data) else {
            throw OSNAuthError.responseMalformed(status: http.statusCode)
        }
        return decoded
    }

    private static func httpResponse(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else {
            throw OSNAuthError.responseMalformed(status: -1)
        }
        return http
    }
}
