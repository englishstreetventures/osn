import Foundation

/// SimpleWebAuthn's `PublicKeyCredentialCreationOptionsJSON` — the unwrapped
/// body of `POST /passkey/register/begin`
/// (`osn/api/src/services/auth/passkeys.ts:75-174`).
public struct PublicKeyCredentialCreationOptionsJSON: Sendable, Equatable, Decodable {
    public let rp: RelyingPartyJSON
    public let user: UserEntityJSON
    public let challenge: String
    public let pubKeyCredParams: [PubKeyCredParamJSON]
    public let timeout: Int?
    public let excludeCredentials: [AllowCredentialJSON]?
    public let authenticatorSelection: AuthenticatorSelectionJSON?
    public let attestation: String?
}

/// `generateRegistrationOptions` always receives `rpID: config.rpId`
/// (`osn/api/src/services/auth/passkeys.ts:75-174`), so `rp.id` is always
/// present on the wire — modeled non-optional rather than adding an
/// unrequested fallback.
public struct RelyingPartyJSON: Sendable, Equatable, Decodable {
    public let name: String
    public let id: String
}

public struct UserEntityJSON: Sendable, Equatable, Decodable {
    public let id: String
    public let name: String
    public let displayName: String
}

public struct PubKeyCredParamJSON: Sendable, Equatable, Decodable {
    public let alg: Int
    public let type: String
}

public struct AuthenticatorSelectionJSON: Sendable, Equatable, Decodable {
    public let residentKey: String?
    public let userVerification: String?
}

/// SimpleWebAuthn's `RegistrationResponseJSON` — the attestation sent to
/// `POST /passkey/register/complete` as `body.attestation`.
public struct RegistrationResponseJSON: Sendable, Equatable, Encodable {
    public let id: String
    public let rawId: String
    public let type: String
    public let authenticatorAttachment: String?
    public let clientExtensionResults: EmptyClientExtensionResults
    public let response: AuthenticatorAttestationResponseJSON

    public init(id: String, rawId: String, authenticatorAttachment: String?, response: AuthenticatorAttestationResponseJSON) {
        self.id = id
        self.rawId = rawId
        type = "public-key"
        self.authenticatorAttachment = authenticatorAttachment
        clientExtensionResults = EmptyClientExtensionResults()
        self.response = response
    }
}

public struct AuthenticatorAttestationResponseJSON: Sendable, Equatable, Encodable {
    public let clientDataJSON: String
    public let attestationObject: String

    public init(clientDataJSON: String, attestationObject: String) {
        self.clientDataJSON = clientDataJSON
        self.attestationObject = attestationObject
    }
}

/// `POST /passkey/register/complete` success body.
public struct PasskeyEnrollmentResult: Sendable, Equatable, Decodable {
    public let passkeyId: String
}

struct RegisterBeginRequestBody: Encodable {
    let profileId: String
    let step_up_token: String?
}

struct RegisterCompleteRequestBody: Encodable {
    let profileId: String
    let attestation: RegistrationResponseJSON
}
