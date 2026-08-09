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
    private let session: URLSession
    private let environment: Environment

    public init(session: URLSession, environment: Environment) {
        self.session = session
        self.environment = environment
    }

    public func list() async throws -> [PasskeySummary] {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("passkeys"))
        request.httpMethod = "GET"
        try RequestHelpers.applyBearerAccessToken(to: &request)

        let (data, response) = try await session.data(for: request)
        let http = try Self.httpResponse(response)
        guard http.statusCode == 200 else {
            throw RequestHelpers.opaqueFailure(status: http.statusCode, data: data)
        }
        guard let decoded = try? JSONDecoder().decode(PasskeyListResponse.self, from: data) else {
            throw OSNAuthError.responseMalformed(status: http.statusCode)
        }
        return decoded.passkeys
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
        try RequestHelpers.applyBearerAccessToken(to: &request)
        request.httpBody = try JSONEncoder().encode(RenameRequestBody(label: label))

        let (data, response) = try await session.data(for: request)
        let http = try Self.httpResponse(response)
        guard http.statusCode == 200 else {
            throw RequestHelpers.opaqueFailure(status: http.statusCode, data: data)
        }
        guard let decoded = try? JSONDecoder().decode(PasskeyRenameResult.self, from: data),
              decoded.success else {
            throw OSNAuthError.responseMalformed(status: http.statusCode)
        }
    }

    /// `stepUpToken` must have been minted via `StepUpPasskeyClient` with
    /// `purpose: "passkey_delete"`.
    public func delete(id: String, stepUpToken: String) async throws -> PasskeyDeleteResult {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("passkeys/\(id)"))
        request.httpMethod = "DELETE"
        request.setValue(stepUpToken, forHTTPHeaderField: "X-Step-Up-Token")
        try RequestHelpers.applyBearerAccessToken(to: &request)

        let (data, response) = try await session.data(for: request)
        let http = try Self.httpResponse(response)
        guard http.statusCode == 200 else {
            throw RequestHelpers.opaqueFailure(status: http.statusCode, data: data)
        }
        guard let decoded = try? JSONDecoder().decode(PasskeyDeleteResult.self, from: data) else {
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
