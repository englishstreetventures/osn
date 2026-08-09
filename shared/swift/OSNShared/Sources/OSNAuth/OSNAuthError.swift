import Foundation

public enum OSNAuthError: Error, Sendable, Equatable, CustomStringConvertible {
    /// A Bearer-authenticated call was attempted with no access token in the
    /// Keychain — the caller must sign in (or refresh) first.
    case accessTokenMissing
    /// An opaque 4xx/429 the server sent without an interpretable `error`
    /// code (brief §5 — passkey login failure is deliberately opaque).
    case requestFailed(status: Int, error: String?)
    /// `403 { "error": "step_up_required" }` on management endpoints.
    case stepUpRequired
    /// `409 { "error": "session_stale" }` on enrollment/delete.
    case sessionStale(message: String?)
    /// A 200 whose body didn't decode as the shape the brief specifies.
    case responseMalformed(status: Int)
    /// `ASAuthorization.credential` wasn't the platform passkey type this
    /// call requested — an internal AuthenticationServices safety check,
    /// not a server contract violation.
    case unexpectedCredentialType

    public var description: String {
        switch self {
        case .accessTokenMissing:
            "accessTokenMissing"
        case .requestFailed(let status, let error):
            "requestFailed(status: \(status), error: \(error ?? "nil"))"
        case .stepUpRequired:
            "stepUpRequired"
        case .sessionStale(let message):
            "sessionStale(message: \(message ?? "nil"))"
        case .responseMalformed(let status):
            "responseMalformed(status: \(status))"
        case .unexpectedCredentialType:
            "unexpectedCredentialType"
        }
    }
}
