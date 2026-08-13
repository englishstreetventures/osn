import Foundation
import OpenAPIRuntime
import OpenAPIURLSession
import OSNKit
import OSNTransport

/// Assembles the generated osn-api client on the shared, cookie-jar-backed
/// `URLSession`, with the bearer-token middleware attached under the
/// spec-derived auth policy.
///
/// Pass the same `session` every OSN app in the group uses
/// (`SharedCookieJar.makeSession()`), and the same `TokenRefresher` built on
/// it. Two refreshers over one jar would race `/token`, and a rotated-out
/// session cookie replayed by the loser trips reuse detection and revokes
/// the whole family — the failure PR #289 fixed on the web client.
public func makeOSNClient(
    environment: Environment,
    session: URLSession,
    tokenRefresher: TokenRefresher
) -> Client {
    Client(
        serverURL: environment.baseURL,
        transport: URLSessionTransport(configuration: .init(session: session)),
        middlewares: [
            BearerTokenMiddleware(
                tokenRefresher: tokenRefresher,
                requiresAuthentication: OSNAuthenticatedOperations.requiresAuthentication
            )
        ]
    )
}
