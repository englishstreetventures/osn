import AuthenticationServices
import Foundation
import OSNKit

/// `POST /passkey/register/begin` + `/complete` (brief §3).
public final class PasskeyEnrollmentClient: Sendable {
    private let session: URLSession
    private let environment: Environment

    public init(session: URLSession, environment: Environment) {
        self.session = session
        self.environment = environment
    }

    /// Registers a new passkey for `profileId`. `stepUpToken` is `nil` for
    /// the first passkey on an account — the server has no step-up ceremony
    /// reachable pre-credential and bypasses the gate itself (brief §3); a
    /// later 4xx is the server's own signal that a step-up was required,
    /// never a client-side decision.
    ///
    /// Both calls are Bearer-authed off the stored access token, exactly like
    /// management and step-up: `passkey-enroll.ts:44` and `:88` resolve the
    /// caller through `resolvePasskeyEnrollPrincipal(headers.authorization)`
    /// (`context.ts:231`), which 401s without it. The session cookie still
    /// rides along from the shared jar, but it is *not* what authenticates —
    /// the server reads it only to name the caller's own session so the S-H1
    /// sweep spares it (`passkey-enroll.ts:98`).
    @MainActor
    public func register(
        profileId: String,
        stepUpToken: String?,
        anchorProvider: @escaping PresentationAnchorProvider
    ) async throws -> PasskeyEnrollmentResult {
        let options = try await beginRegistration(profileId: profileId, stepUpToken: stepUpToken)

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options.rp.id)
        guard let challenge = Base64URL.decode(options.challenge),
              let userID = Base64URL.decode(options.user.id) else {
            throw OSNAuthError.responseMalformed(status: 200)
        }
        let registrationRequest = provider.createCredentialRegistrationRequest(
            challenge: challenge,
            name: options.user.name,
            userID: userID
        )
        if let preference = RequestHelpers.userVerificationPreference(
            from: options.authenticatorSelection?.userVerification
        ) {
            registrationRequest.userVerificationPreference = preference
        }

        let authorization = try await PasskeyCeremony.perform(
            requests: [registrationRequest],
            anchorProvider: anchorProvider
        )
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
            throw OSNAuthError.unexpectedCredentialType
        }
        guard let attestationObject = credential.rawAttestationObject else {
            throw OSNAuthError.unexpectedCredentialType
        }

        let attestation = RegistrationResponseJSON(
            id: Base64URL.encode(credential.credentialID),
            rawId: Base64URL.encode(credential.credentialID),
            authenticatorAttachment: "platform",
            response: AuthenticatorAttestationResponseJSON(
                clientDataJSON: Base64URL.encode(credential.rawClientDataJSON),
                attestationObject: Base64URL.encode(attestationObject)
            )
        )

        return try await completeRegistration(profileId: profileId, attestation: attestation)
    }

    private func beginRegistration(
        profileId: String,
        stepUpToken: String?
    ) async throws -> PublicKeyCredentialCreationOptionsJSON {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("passkey/register/begin"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        try RequestHelpers.applyBearerAccessToken(to: &request)
        if let stepUpToken {
            request.setValue(stepUpToken, forHTTPHeaderField: "X-Step-Up-Token")
        }
        request.httpBody = try JSONEncoder().encode(
            RegisterBeginRequestBody(profileId: profileId, step_up_token: nil)
        )

        let (data, response) = try await session.data(for: request)
        let http = try Self.httpResponse(response)
        guard http.statusCode == 200 else {
            throw RequestHelpers.opaqueFailure(status: http.statusCode, data: data)
        }
        guard let decoded = try? JSONDecoder().decode(PublicKeyCredentialCreationOptionsJSON.self, from: data) else {
            throw OSNAuthError.responseMalformed(status: http.statusCode)
        }
        return decoded
    }

    private func completeRegistration(
        profileId: String,
        attestation: RegistrationResponseJSON
    ) async throws -> PasskeyEnrollmentResult {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("passkey/register/complete"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        try RequestHelpers.applyBearerAccessToken(to: &request)
        request.httpBody = try JSONEncoder().encode(
            RegisterCompleteRequestBody(profileId: profileId, attestation: attestation)
        )

        let (data, response) = try await session.data(for: request)
        let http = try Self.httpResponse(response)
        guard http.statusCode == 200 else {
            throw RequestHelpers.opaqueFailure(status: http.statusCode, data: data)
        }
        guard let decoded = try? JSONDecoder().decode(PasskeyEnrollmentResult.self, from: data) else {
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
