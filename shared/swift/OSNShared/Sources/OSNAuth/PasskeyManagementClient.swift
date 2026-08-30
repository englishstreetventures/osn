import Foundation
import OSNKit

/// `GET /passkeys`, `PATCH /passkeys/:id`, `DELETE /passkeys/:id` (brief §4).
/// All three are Bearer-authed off the stored access token. Rename and
/// delete additionally require a step-up token minted with purpose
/// `"passkey_delete"` — the server deliberately shares one verifier for
/// both (`osn/api/src/services/auth/step-up.ts:398-400`: "Rename shares
/// this verifier, so the client mints `passkey_delete` for both rename and
/// delete"). This is intentional server behavior to mirror, not a bug to
/// "fix" to a separate `passkey_rename` purpose.
public final class PasskeyManagementClient: Sendable {
    private let transport: AuthenticatedTransport
    private let environment: Environment

    /// - Parameter tokenRefresher: the session's own refresher, never a
    ///   freshly built one. `TokenRefresher` coalesces concurrent `/token`
    ///   requests per instance, and every grant rotates the session cookie,
    ///   so two refreshers sharing one cookie jar race and the loser replays
    ///   a rotated-out cookie — which trips reuse detection and revokes the
    ///   whole session family. `OSNSession.tokenRefresher` is public for
    ///   exactly this.
    public init(session: URLSession, environment: Environment, tokenRefresher: TokenRefresher) {
        self.transport = AuthenticatedTransport(
            session: session,
            environment: environment,
            tokenRefresher: tokenRefresher
        )
        self.environment = environment
    }

    public func list() async throws -> [PasskeySummary] {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("passkeys"))
        request.httpMethod = "GET"
        return try await transport.decode(PasskeyListResponse.self, from: request).passkeys
    }

    /// `stepUpToken` must have been minted via `StepUpPasskeyClient` with
    /// `purpose: "passkey_delete"` (see type doc above).
    ///
    /// Returns nothing: the server's success body is a bare
    /// `{ "success": true }` (`passkey-management.ts:84`), not the updated
    /// summary. Decoding a `PasskeySummary` here would throw
    /// `.responseMalformed` on the happy path, *after* the rename had already
    /// committed. Callers that need the new label back should re-`list()`.
    public func rename(id: String, label: String, stepUpToken: String) async throws {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("passkeys/\(id)"))
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(stepUpToken, forHTTPHeaderField: "X-Step-Up-Token")
        request.httpBody = try JSONEncoder().encode(RenameRequestBody(label: label))

        let result = try await transport.decode(PasskeyRenameResult.self, from: request)
        guard result.success else {
            throw OSNAuthError.responseMalformed(status: 200)
        }
    }

    /// `stepUpToken` must have been minted via `StepUpPasskeyClient` with
    /// `purpose: "passkey_delete"`.
    public func delete(id: String, stepUpToken: String) async throws -> PasskeyDeleteResult {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("passkeys/\(id)"))
        request.httpMethod = "DELETE"
        request.setValue(stepUpToken, forHTTPHeaderField: "X-Step-Up-Token")

        return try await transport.decode(PasskeyDeleteResult.self, from: request)
    }
}
