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
    /// The skew allowance and the refresh path both live in
    /// `AccessTokenProvider`, shared with `AuthenticatedTransport` behind the
    /// `OSNAuth` clients. This middleware used to declare its own `30`, and a
    /// change to one silently diverged from the other.
    private let tokens: AccessTokenProvider

    public init(tokenRefresher: TokenRefresher) {
        self.tokens = AccessTokenProvider(tokenRefresher: tokenRefresher)
    }

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        let resolved = try await tokens.bearerTokenRefreshingWhenAbsent()
        request.headerFields[.authorization] = "Bearer \(resolved.token)"

        let (response, responseBody) = try await next(request, body, baseURL)
        // A token minted moments ago inside this very call is not worth
        // retrying: the server rejecting one it just issued will reject its
        // replacement too, and the second `/token` grant rotates the session
        // cookie again for nothing.
        guard response.status.code == 401, !resolved.wasJustMinted else {
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

        let freshToken = try await tokens.refreshedBearerToken(replacing: resolved.token)
        request.headerFields[.authorization] = "Bearer \(freshToken)"
        return try await next(request, body, baseURL)
    }
}
