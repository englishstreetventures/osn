import Foundation
import HTTPTypes
import OpenAPIRuntime
import OSNKit

/// Injects the OSN access token into every outgoing Pulse request. Uses the
/// cached Keychain token when it isn't near expiry; otherwise calls
/// `TokenRefresher` first, so the first call after launch and every call
/// after the access token's ~5-minute lifetime still authenticates. As a
/// backstop, a 401 from Pulse despite a fresh-looking cached token triggers
/// one refresh-and-retry — never a loop.
public struct BearerTokenMiddleware: ClientMiddleware {
    private let tokenRefresher: TokenRefresher

    /// A cached token within this many seconds of its `expiresAt` is treated
    /// as already gone, so one is never sent moments before the server
    /// would reject it mid-flight.
    private static let expirySkew: TimeInterval = 30

    public init(tokenRefresher: TokenRefresher) {
        self.tokenRefresher = tokenRefresher
    }

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        request.headerFields[.authorization] = "Bearer \(try await validToken())"

        let (response, responseBody) = try await next(request, body, baseURL)
        guard response.status.code == 401 else {
            return (response, responseBody)
        }

        // A `.single` body has already been consumed by the call above and
        // cannot be iterated a second time, so replaying it would trap rather
        // than retry. Every body the generated client produces is encoded from
        // `Data` and is therefore `.multiple`, but a hand-built streaming body
        // would not be — hand the 401 back instead of retrying it.
        if let body, body.iterationBehavior == .single {
            return (response, responseBody)
        }

        let freshToken = try await tokenRefresher.refresh().accessToken
        request.headerFields[.authorization] = "Bearer \(freshToken)"
        return try await next(request, body, baseURL)
    }

    private func validToken() async throws -> String {
        if let cached = try KeychainAccessTokenStore.load(),
            cached.expiresAt.timeIntervalSinceNow > Self.expirySkew
        {
            return cached.token
        }
        return try await tokenRefresher.refresh().accessToken
    }
}
