import Foundation
import OSNKit

/// Refuses to carry a request across hosts.
///
/// Foundation follows a 3xx on its own and re-applies the original request's
/// headers to the redirected one, `Authorization` included, whatever host it
/// points at. None of the five routes these clients call ever redirects, so
/// declining outright costs nothing and means an open redirect on the API
/// host — or a mistyped `Environment.baseURL` — cannot hand a third-party
/// origin the account's access token. Returning `nil` surfaces the 3xx as
/// the response instead of following it, which `body(_:_:)` then reports as
/// a request failure.
private final class SameHostRedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let host: String?

    init(host: String?) {
        self.host = host
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        guard let host, request.url?.host == host else { return nil }
        return request
    }
}

/// The single path every Bearer-authenticated `OSNAuth` request takes.
///
/// Each client used to repeat the same five steps — build the request, paste
/// on whatever token the Keychain held, send it, check the status, decode —
/// and the paste step had no expiry check and no retry. A screen left open
/// past the access token's five-minute TTL (`wiki/systems/identity-model.md`)
/// therefore just failed, and every new call site had to remember to call
/// `OSNSession.ensureFreshAccessToken()` first; forgetting was silent.
///
/// Retrying a 401 is safe on every route these clients call, including the
/// three that carry a single-use `X-Step-Up-Token`. Each route resolves the
/// bearer principal and returns 401 *before* it verifies the step-up token
/// (`osn/api/src/routes/auth/passkey-management.ts:81` and `:140`,
/// `passkey-enroll.ts:46`), and `lib/public-error.ts` maps no tagged error to
/// 401, so a 401 on these routes has exactly one source: that pre-auth check.
/// The first attempt therefore consumed neither the step-up jti nor the
/// WebAuthn challenge, and both are still good on the retry.
///
/// What this does **not** do is decide who the caller is. It authenticates as
/// whatever the shared Keychain slot holds, which a sibling app in the same
/// App Group can rotate to a different account's token between one call and
/// the next. Reconciling that against what is on screen stays with
/// `OSNSession.ensureFreshAccessToken()` (S-H1), and a screen that shows or
/// acts on identity still calls it first.
///
/// The request-time Keychain read runs on the concurrent executor rather
/// than the caller's actor. That was already true of the per-client reads
/// this replaced — they sat in `nonisolated async` methods too — so the
/// value here is not that it moved, but that `AccessTokenProvider` now pins
/// it with `@concurrent` instead of leaving it to the current default for
/// `nonisolated async`, which a language-mode bump would flip.
struct AuthenticatedTransport: Sendable {
    /// One decoder for every response in the package. It carries no per-call
    /// state, so the per-request allocation each client used to make bought
    /// nothing.
    private static let decoder = JSONDecoder()

    private let session: URLSession
    private let tokens: AccessTokenProvider
    private let redirectGuard: SameHostRedirectGuard

    init(session: URLSession, environment: Environment, tokenRefresher: TokenRefresher) {
        self.session = session
        self.tokens = AccessTokenProvider(tokenRefresher: tokenRefresher)
        self.redirectGuard = SameHostRedirectGuard(host: environment.baseURL.host)
    }

    /// Sends `request` with a bearer token resolved from one Keychain read
    /// and returns the 200 body.
    ///
    /// On a 401 — the server rejected a token that looked fresh here, which
    /// is what a clock difference or a sibling app's sign-out produces — it
    /// refreshes once and sends the request again. A second 401 is reported,
    /// never retried: `TokenRefresher` is the only thing that can mint a
    /// token, and it has already had its turn.
    ///
    /// A token minted during this very call is not retried either. The server
    /// rejecting a token it issued moments ago will reject its replacement
    /// too, so the retry would buy one more round trip and one more session
    /// cookie rotation for nothing.
    ///
    /// Throws `.accessTokenMissing` rather than sending an unauthenticated
    /// request that the server would 401 anyway.
    func data(for request: URLRequest) async throws -> Data {
        guard let resolved = try await tokens.storedSessionBearerToken() else {
            throw OSNAuthError.accessTokenMissing
        }
        var request = request
        request.setValue("Bearer \(resolved.token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await session.data(for: request, delegate: redirectGuard)
        let http = try Self.httpResponse(response)
        guard http.statusCode == 401, !resolved.wasJustMinted, Self.isReplayable(request) else {
            return try Self.body(data, http)
        }

        let freshToken = try await tokens.refreshedBearerToken(replacing: resolved.token)
        request.setValue("Bearer \(freshToken)", forHTTPHeaderField: "Authorization")
        let (retryData, retryResponse) = try await session.data(for: request, delegate: redirectGuard)
        let retryHTTP = try Self.httpResponse(retryResponse)
        return try Self.body(retryData, retryHTTP)
    }

    /// `data(for:)` plus the decode every caller does with the result. A 200
    /// that doesn't decode is `.responseMalformed`, not a request failure —
    /// the call reached the server and the server agreed to it.
    func decode<T: Decodable>(_ type: T.Type, from request: URLRequest) async throws -> T {
        let data = try await data(for: request)
        guard let decoded = try? Self.decoder.decode(type, from: data) else {
            throw OSNAuthError.responseMalformed(status: 200)
        }
        return decoded
    }

    /// A body already streamed to the server cannot be sent a second time,
    /// so a request carrying one gets its 401 handed back instead of a retry
    /// that would send nothing. Every request these clients build sets
    /// `httpBody` — plain `Data`, replayable — or carries no body at all;
    /// the guard is for the hand-built request that doesn't.
    private static func isReplayable(_ request: URLRequest) -> Bool {
        request.httpBodyStream == nil
    }

    private static func body(_ data: Data, _ http: HTTPURLResponse) throws -> Data {
        guard http.statusCode == 200 else {
            throw RequestHelpers.opaqueFailure(status: http.statusCode, data: data)
        }
        return data
    }

    private static func httpResponse(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else {
            throw OSNAuthError.responseMalformed(status: -1)
        }
        return http
    }
}
