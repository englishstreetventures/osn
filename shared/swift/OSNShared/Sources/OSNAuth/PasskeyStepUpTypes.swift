import Foundation

/// `POST /step-up/passkey/begin` response (`osn/api/src/routes/auth/step-up.ts:39`,
/// `osn/api/src/services/auth/step-up.ts:185-226`) — no request body, Bearer-authed.
public struct StepUpPasskeyBeginResponse: Sendable, Equatable, Decodable {
    public let options: PublicKeyCredentialRequestOptionsJSON
}

/// The server's literal union of step-up purposes
/// (`osn/api/src/routes/auth/step-up.ts:89-101`). Modeled as an enum so a
/// typo can't reach the wire and come back a 422 — the same reason
/// `PasskeyLoginTarget` is an enum rather than two optionals.
///
/// `passkeyDelete` covers **both** rename and delete: the server shares one
/// verifier for the pair (`osn/api/src/services/auth/step-up.ts:398-400`).
/// There is no `passkey_rename` purpose to "fix" this to.
public enum StepUpPurpose: String, Sendable, Equatable, Encodable {
    case accountDelete = "account_delete"
    case accountExport = "account_export"
    case pulseAppDelete = "pulse_app_delete"
    case zapAppDelete = "zap_app_delete"
    case recoveryGenerate = "recovery_generate"
    case passkeyRegister = "passkey_register"
    case passkeyDelete = "passkey_delete"
    case emailChange = "email_change"
    case securityEventAck = "security_event_ack"
}

/// `POST /step-up/passkey/complete` request body
/// (`osn/api/src/routes/auth/step-up.ts:87-102`).
struct StepUpPasskeyCompleteRequestBody: Encodable {
    let assertion: AuthenticationResponseJSON
    let purpose: StepUpPurpose?
}

/// `POST /step-up/passkey/complete` success body
/// (`osn/api/src/routes/auth/step-up.ts:73-76`).
public struct StepUpPasskeyCompleteResponse: Sendable, Equatable, Decodable {
    public let stepUpToken: String
    public let expiresIn: Int

    enum CodingKeys: String, CodingKey {
        case stepUpToken = "step_up_token"
        case expiresIn = "expires_in"
    }
}
