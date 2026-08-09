import AuthenticationServices
import Foundation
import OSNKit

/// `POST /login/passkey/begin` + `/complete` (brief §1, §2).
public final class PasskeyLoginClient: Sendable {
    private let session: URLSession
    private let environment: Environment

    /// `session` must be built from `SharedCookieJar.makeConfiguration()`
    /// (trap 6) — a bare `URLSession.shared` silently misroutes the cookie.
    public init(session: URLSession, environment: Environment) {
        self.session = session
        self.environment = environment
    }

    /// Runs both login flows: `identifier == nil` is discoverable/conditional
    /// UI (empty `allowCredentials`, Turnstile not gated); `identifier` present
    /// is account-bound (populated `allowCredentials`, Turnstile gated when
    /// configured). A successful `begin` proves nothing about account
    /// existence — the server fabricates `allowCredentials` for unknown
    /// identifiers to resist enumeration, so this never branches on that.
    @MainActor
    public func signIn(
        identifier: String?,
        turnstileToken: String? = nil,
        anchorProvider: @escaping PresentationAnchorProvider
    ) async throws -> PasskeyLoginCompleteResponse {
        let begun = try await begin(identifier: identifier, turnstileToken: turnstileToken)
        let options = begun.options

        // RP ID always comes off the response (DoD 4) — never hardcoded.
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

        let target: PasskeyLoginTarget
        if let identifier {
            target = .identifier(identifier)
        } else if let challengeId = begun.challengeId {
            target = .challengeId(challengeId)
        } else {
            throw OSNAuthError.responseMalformed(status: 200)
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

        return try await complete(target: target, assertion: assertion)
    }

    private func begin(identifier: String?, turnstileToken: String?) async throws -> PasskeyLoginBeginResponse {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("login/passkey/begin"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            PasskeyLoginBeginRequestBody(identifier: identifier, turnstileToken: turnstileToken)
        )

        let (data, response) = try await session.data(for: request)
        let http = try Self.httpResponse(response)
        guard http.statusCode == 200 else {
            throw RequestHelpers.opaqueFailure(status: http.statusCode, data: data)
        }
        guard let decoded = try? JSONDecoder().decode(PasskeyLoginBeginResponse.self, from: data) else {
            throw OSNAuthError.responseMalformed(status: http.statusCode)
        }
        return decoded
    }

    /// Internal, not private: lets `OSNAuthTests` exercise the
    /// decode-persist-verify path (DoD 2) against a mocked `URLSession`
    /// without driving a real `ASAuthorizationController` ceremony.
    func complete(
        target: PasskeyLoginTarget,
        assertion: AuthenticationResponseJSON
    ) async throws -> PasskeyLoginCompleteResponse {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("login/passkey/complete"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(PasskeyCompleteRequestBody(target: target, assertion: assertion))

        let (data, response) = try await session.data(for: request)
        let http = try Self.httpResponse(response)
        guard http.statusCode == 200 else {
            throw RequestHelpers.opaqueFailure(status: http.statusCode, data: data)
        }
        guard let decoded = try? JSONDecoder().decode(PasskeyLoginCompleteResponse.self, from: data) else {
            throw OSNAuthError.responseMalformed(status: http.statusCode)
        }

        // Brief §2 "must": persist the access token, then verify the
        // rotated session cookie actually landed in the shared jar.
        try KeychainAccessTokenStore.save(decoded.session.accessToken, expiresIn: TimeInterval(decoded.session.expiresIn))
        try RequestHelpers.verifySessionCookiePersisted(session: session, environment: environment)

        return decoded
    }

    private static func httpResponse(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else {
            throw OSNAuthError.responseMalformed(status: -1)
        }
        return http
    }
}
