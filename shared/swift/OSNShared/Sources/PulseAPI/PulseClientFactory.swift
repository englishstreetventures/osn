import Foundation
import OpenAPIRuntime
import OpenAPIURLSession
import OSNKit
import OSNTransport

/// Assembles the generated Pulse client on top of the shared,
/// cookie-jar-backed `URLSession` from deliverable 1, with the bearer-token
/// middleware from deliverable 2 attached. Pulse's whole surface is
/// authenticated, so it takes the middleware's default policy — every
/// operation gets a token.
public func makePulseClient(
    environment: PulseEnvironment,
    session: URLSession,
    tokenRefresher: TokenRefresher
) -> Client {
    Client(
        serverURL: environment.baseURL,
        transport: URLSessionTransport(configuration: .init(session: session)),
        middlewares: [BearerTokenMiddleware(tokenRefresher: tokenRefresher)]
    )
}
