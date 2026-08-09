import Foundation
import OSNKit

/// SimpleWebAuthn's `PublicKeyCredentialRequestOptionsJSON`, as returned by
/// `POST /login/passkey/begin` and `POST /step-up/passkey/begin`.
public struct PublicKeyCredentialRequestOptionsJSON: Sendable, Equatable, Decodable {
    public let challenge: String
    public let timeout: Int?
    public let rpId: String
    public let allowCredentials: [AllowCredentialJSON]
    public let userVerification: String
}

public struct AllowCredentialJSON: Sendable, Equatable, Codable {
    public let id: String
    public let type: String
    public let transports: [String]?
}

/// SimpleWebAuthn's `AuthenticationResponseJSON` — the assertion sent back to
/// `/login/passkey/complete` and `/step-up/passkey/complete`.
public struct AuthenticationResponseJSON: Sendable, Equatable, Encodable {
    public let id: String
    public let rawId: String
    public let type: String
    public let authenticatorAttachment: String?
    public let clientExtensionResults: EmptyClientExtensionResults
    public let response: AuthenticatorAssertionResponseJSON

    public init(
        id: String,
        rawId: String,
        authenticatorAttachment: String?,
        response: AuthenticatorAssertionResponseJSON
    ) {
        self.id = id
        self.rawId = rawId
        type = "public-key"
        self.authenticatorAttachment = authenticatorAttachment
        clientExtensionResults = EmptyClientExtensionResults()
        self.response = response
    }
}

/// No extensions are requested anywhere in this brief — an empty object is
/// the correct wire value, not a placeholder for ones we forgot.
public struct EmptyClientExtensionResults: Sendable, Equatable, Encodable {
    public init() {}
}

public struct AuthenticatorAssertionResponseJSON: Sendable, Equatable, Encodable {
    public let clientDataJSON: String
    public let authenticatorData: String
    public let signature: String
    /// Optional and absent (never `null`) for a non-discoverable credential
    /// (trap 4) — Swift's synthesized `Encodable` already `encodeIfPresent`s
    /// an `Optional`-typed stored property, so no custom `encode(to:)` is
    /// needed to satisfy that.
    public let userHandle: String?

    public init(clientDataJSON: String, authenticatorData: String, signature: String, userHandle: String?) {
        self.clientDataJSON = clientDataJSON
        self.authenticatorData = authenticatorData
        self.signature = signature
        self.userHandle = userHandle
    }
}

/// `/login/passkey/complete` requires **exactly one** of `identifier` or
/// `challengeId` — both or neither is a `400 invalid_request`. Modeled as an
/// enum so the invalid states aren't representable in Swift (brief §2).
public enum PasskeyLoginTarget: Sendable, Equatable {
    case identifier(String)
    case challengeId(String)
}

struct PasskeyLoginBeginRequestBody: Encodable {
    let identifier: String?
    let turnstileToken: String?
}

struct PasskeyCompleteRequestBody: Encodable {
    let identifier: String?
    let challengeId: String?
    let assertion: AuthenticationResponseJSON

    init(target: PasskeyLoginTarget, assertion: AuthenticationResponseJSON) {
        switch target {
        case .identifier(let value):
            identifier = value
            challengeId = nil
        case .challengeId(let value):
            identifier = nil
            challengeId = value
        }
        self.assertion = assertion
    }
}

public struct PasskeyLoginBeginResponse: Sendable, Equatable, Decodable {
    public let options: PublicKeyCredentialRequestOptionsJSON
    public let challengeId: String?
}

/// `osn/api/src/services/auth/types.ts:92` — `PublicProfile`.
public struct PasskeyProfile: Sendable, Equatable, Decodable {
    public let id: String
    public let handle: String
    public let email: String
    public let displayName: String?
    public let avatarUrl: String?
}

/// `osn/api/src/routes/auth/context.ts:34` success body of
/// `/login/passkey/complete`. `session` reuses `OSNKit.TokenGrant` — it is
/// `toTokenResponseCookieOnly`'s exact shape, already decoded there.
public struct PasskeyLoginCompleteResponse: Sendable, Equatable, Decodable {
    public let session: TokenGrant
    public let profile: PasskeyProfile
}
