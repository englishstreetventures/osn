import Foundation
import OpenAPIRuntime
import OpenAPIURLSession
import OSNKit

/// Assembles the generated Pulse client on top of the shared,
/// cookie-jar-backed `URLSession` from deliverable 1, with the bearer-token
/// middleware from deliverable 2 attached.
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
