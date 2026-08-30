import AuthenticationServices
import Foundation
import OSNKit

/// `POST /step-up/passkey/begin` + `/complete` (brief §4) — mints a
/// short-lived step-up token for `X-Step-Up-Token` on management calls.
/// OTP step-up (`step-up.ts:105`, `:135`) is web-only fallback and out of
/// scope here (brief §4).
public final class StepUpPasskeyClient: Sendable {
    private let transport: AuthenticatedTransport
    private let environment: Environment

    /// - Parameter tokenRefresher: the session's own refresher — see
    ///   `PasskeyManagementClient.init` for why a second one on the same
    ///   cookie jar revokes the session family.
    public init(session: URLSession, environment: Environment, tokenRefresher: TokenRefresher) {
        self.transport = AuthenticatedTransport(
            session: session,
            environment: environment,
            tokenRefresher: tokenRefresher
        )
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

    /// `internal`, not `private`, so a test can assert the request shape
    /// without running a real passkey ceremony — `mintStepUpToken` cannot run
    /// headless, and this is the half that talks to the server.
    func begin() async throws -> StepUpPasskeyBeginResponse {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("step-up/passkey/begin"))
        request.httpMethod = "POST"

        return try await transport.decode(StepUpPasskeyBeginResponse.self, from: request)
    }

    /// `internal` for the same reason as `begin()`.
    func complete(
        assertion: AuthenticationResponseJSON,
        purpose: StepUpPurpose
    ) async throws -> StepUpPasskeyCompleteResponse {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("step-up/passkey/complete"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            StepUpPasskeyCompleteRequestBody(assertion: assertion, purpose: purpose)
        )

        return try await transport.decode(StepUpPasskeyCompleteResponse.self, from: request)
    }
}
