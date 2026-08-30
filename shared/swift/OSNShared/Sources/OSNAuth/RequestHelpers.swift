import AuthenticationServices
import Foundation
import OSNKit

struct ServerErrorBody: Decodable {
    let error: String?
    let message: String?
}

/// What is left of the per-client request plumbing once
/// `AuthenticatedTransport` owns the authenticated path: the response
/// mapping and the ceremony helpers that both authenticated and
/// unauthenticated clients share. Applying the bearer token lived here too
/// until the transport took it over — it pasted on whatever the Keychain
/// held, with no expiry check and no retry.
enum RequestHelpers {
    /// Trap 6 / brief §2 — verifies the session cookie actually landed in
    /// the shared jar after a successful `/login/passkey/complete`, mirroring
    /// `TokenRefresher.verifySessionCookiePersisted()` in `OSNKit` exactly
    /// (same cookie-name derivation, same jar check), reusing
    /// `OSNKitError.sessionCookieNotPersisted` rather than inventing a
    /// second spelling of the same failure (brief §2.2).
    static func verifySessionCookiePersisted(session: URLSession, environment: Environment) throws {
        let name = sessionCookieName(for: environment)
        let cookies = session.configuration.httpCookieStorage?.cookies(for: environment.baseURL) ?? []
        guard cookies.contains(where: { $0.name == name }) else {
            throw OSNKitError.sessionCookieNotPersisted(name: name, host: environment.baseURL.host ?? "")
        }
    }

    /// Brief §5 — passkey ceremony failures are a deliberately opaque 4xx;
    /// the only codes worth naming are the two management endpoints
    /// document explicitly (`step_up_required`, `session_stale`). Everything
    /// else stays an opaque `.requestFailed` — never inferred beyond the
    /// status/error string the server actually sent.
    static func opaqueFailure(status: Int, data: Data) -> OSNAuthError {
        let body = try? JSONDecoder().decode(ServerErrorBody.self, from: data)
        switch (status, body?.error) {
        case (403, "step_up_required"):
            return .stepUpRequired
        case (409, "session_stale"):
            return .sessionStale(message: body?.message)
        default:
            return .requestFailed(status: status, error: body?.error)
        }
    }

    /// Maps SimpleWebAuthn's `userVerification` string onto Apple's enum.
    /// Never invents a fallback for an unrecognized value — `nil` leaves
    /// Apple's own default in effect rather than guessing one.
    static func userVerificationPreference(
        from value: String?
    ) -> ASAuthorizationPublicKeyCredentialUserVerificationPreference? {
        switch value {
        case "required":
            .required
        case "preferred":
            .preferred
        case "discouraged":
            .discouraged
        default:
            nil
        }
    }
}
