import Foundation

/// The decoded success body of `POST /token`
/// (`osn/api/src/routes/auth/context.ts:34-41`) — `toTokenResponseCookieOnly`.
public struct TokenGrant: Sendable, Equatable, Decodable {
    public let accessToken: String
    public let tokenType: String
    public let expiresIn: Int
    public let scope: String

    private enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
        case scope
    }
}

private struct RefreshRequestBody: Encodable {
    let grant_type = "refresh_token"
}

private struct RefreshErrorBody: Decodable {
    let error: String
    let message: String?
}

/// Drives `POST /token` and `POST /logout` (`osn/api/src/routes/auth/tokens.ts`),
/// both mounted at the environment's base URL with no group prefix.
///
/// Refresh failure is **HTTP 400 with an `error` string, never 401** — the
/// server never returns 401 from this endpoint. A refresher that branches on
/// 401 will never notice a dead session and will retry forever (door 4).
///
/// Every `/token` grant rotates the session cookie; replaying a rotated-out
/// cookie trips reuse detection and revokes the whole session family (the bug
/// PR #289 fixed on the web client). `refresh()` serialises concurrent
/// callers onto one in-flight request via the actor + a shared `Task`.
public actor TokenRefresher {
    private let session: URLSession
    private let environment: Environment
    private var inFlightTask: Task<TokenGrant, Error>?

    public init(session: URLSession, environment: Environment) {
        self.session = session
        self.environment = environment
    }

    /// Posts the refresh grant, unless one is already in flight — in which
    /// case this call joins it instead of firing a second `/token` request.
    @discardableResult
    public func refresh() async throws -> TokenGrant {
        if let inFlightTask {
            return try await inFlightTask.value
        }
        let task = Task { try await performRefresh() }
        inFlightTask = task
        defer { inFlightTask = nil }
        return try await task.value
    }

    /// Cookie-only, idempotent, always 200 per the server contract — nothing
    /// here is inferred from the response. Clears the locally cached access
    /// token unconditionally: a network failure must not leave a token
    /// cached locally for a session the server may have already destroyed.
    /// A network error is still surfaced, but only after that cleanup runs.
    public func logout() async throws {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("logout"))
        request.httpMethod = "POST"
        var networkError: Error?
        do {
            _ = try await session.data(for: request)
        } catch {
            networkError = error
        }
        try KeychainAccessTokenStore.delete()
        if let networkError {
            throw networkError
        }
    }

    private func performRefresh() async throws -> TokenGrant {
        var request = URLRequest(url: environment.baseURL.appendingPathComponent("token"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(RefreshRequestBody())

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw OSNKitError.refreshResponseMalformed(status: -1)
        }

        switch httpResponse.statusCode {
        case 200:
            guard let grant = try? JSONDecoder().decode(TokenGrant.self, from: data) else {
                throw OSNKitError.refreshResponseMalformed(status: 200)
            }
            // Door 1/3: a 200 with no rotated cookie actually landed in the
            // jar means the wrong session (or the wrong cookie name) is in
            // play — the ceremony "succeeded" and the user is still signed
            // out. Fail loudly here instead of returning a grant that the
            // next request can't use.
            try verifySessionCookiePersisted()
            try KeychainAccessTokenStore.save(grant.accessToken, expiresIn: TimeInterval(grant.expiresIn))
            return grant
        case 400:
            throw refreshFailure(from: data)
        default:
            throw OSNKitError.refreshResponseMalformed(status: httpResponse.statusCode)
        }
    }

    private func verifySessionCookiePersisted() throws {
        let name = sessionCookieName(for: environment)
        let cookies = session.configuration.httpCookieStorage?.cookies(for: environment.baseURL) ?? []
        guard cookies.contains(where: { $0.name == name }) else {
            throw OSNKitError.sessionCookieNotPersisted(name: name, host: environment.baseURL.host ?? "")
        }
    }

    /// Branches on the `error` string exactly as the server sends it
    /// (`osn/api/src/routes/auth/tokens.ts`) — never on status code alone,
    /// since all three failure branches share the same 400.
    private func refreshFailure(from data: Data) -> OSNKitError {
        guard let body = try? JSONDecoder().decode(RefreshErrorBody.self, from: data) else {
            return .refreshResponseMalformed(status: 400)
        }
        switch body.error {
        case "unsupported_grant_type":
            return .refreshUnsupportedGrantType
        case "invalid_request":
            return .refreshCookieMissing
        case "invalid_grant":
            return .refreshSessionInvalid(message: body.message ?? "")
        default:
            return .refreshResponseMalformed(status: 400)
        }
    }
}
