import Foundation

public extension Environment {
    /// Whether osn-api is served over TLS in this environment — mirrors the
    /// `secure` flag `cookieName()` switches on in
    /// `osn/api/src/lib/cookie-session.ts`. `local` has no TLS; every other
    /// tier does.
    var isSecureDeployment: Bool {
        switch self {
        case .local:
            return false
        case .dev, .staging, .production:
            return true
        }
    }
}

/// The session cookie name for `environment`, derived the same way the
/// server derives it (`osn/api/src/lib/cookie-session.ts`). `__Host-`
/// requires `Secure`, so it only applies where TLS is present; `local`
/// drops the prefix. Never hardcode either spelling elsewhere — this is the
/// one place that decides it.
public func sessionCookieName(for environment: Environment) -> String {
    environment.isSecureDeployment ? "__Host-osn_session" : "osn_session"
}
