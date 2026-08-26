import Foundation

/// Errors that close the four silent-failure doors named in the A2 brief
/// (deliverable 4). Each case corresponds to a failure mode that would
/// otherwise show up only as "the ceremony succeeded and the user is still
/// signed out," with nothing in the logs.
public enum OSNKitError: Error, Sendable, Equatable {
    /// Door 2 — the App Group container is unavailable. The group is
    /// registered, so this means the entitlement is missing from this target
    /// or the build is signed by another team. `HTTPCookieStorage
    /// .sharedCookieStorage(forGroupContainerIdentifier:)` does not itself
    /// fail in this case — it silently hands back storage that never
    /// actually shares with another process. This error is raised from a
    /// container-URL check performed *before* that call, so the failure is
    /// loud instead of a mysterious cross-app sign-out.
    case appGroupContainerUnavailable(groupIdentifier: String)

    /// Door 1 / door 3 — a `/token` call returned 200, but the rotated
    /// session cookie the response set does not show up in the shared jar
    /// afterward. Either the configured `URLSession` isn't the shared one,
    /// or the cookie name this build derived doesn't match what the server
    /// actually set (wrong environment, wrong `secure` assumption).
    case sessionCookieNotPersisted(name: String, host: String)

    /// `POST /token` returned 400 `{ "error": "unsupported_grant_type" }` —
    /// only reachable if a caller sends something other than
    /// `grant_type: "refresh_token"`.
    case refreshUnsupportedGrantType

    /// `POST /token` returned 400 `{ "error": "invalid_request" }` — the
    /// session cookie never arrived on the request. This is a jar bug, not
    /// an auth failure, and must be reported as one (brief deliverable 2).
    case refreshCookieMissing

    /// `POST /token` returned 400 `{ "error": "invalid_grant", "message":
    /// "..." }` — the session is gone. Sign the user out.
    case refreshSessionInvalid(message: String)

    /// `POST /token` returned a 200 whose body didn't decode to the
    /// documented shape, or a status/body this client doesn't recognize at
    /// all. Never treat an unrecognized response as success.
    case refreshResponseMalformed(status: Int)

    /// The app's `Info.plist` carries no `OSNTier`. The value is written per
    /// build configuration by XcodeGen from each app's `project.yml`, so this
    /// means the target was built without that setting — a build-configuration
    /// fault, not anything the user did.
    ///
    /// There is deliberately no default. A build whose tier cannot be read
    /// must fail loudly, because the quiet alternative is a release that talks
    /// to `localhost`.
    case deploymentTierMissing(key: String)

    /// `OSNTier` holds something outside `local` / `dev` / `staging` /
    /// `production` — a typo in `project.yml`, which would otherwise resolve
    /// to a silent fallback.
    case deploymentTierUnknown(value: String)

    /// This tier needs a host supplied by the build and none was. `dev` and
    /// `staging` have no fixed osn-api host, and **no Pulse API host is
    /// deployed at any tier**, so a Pulse build outside `local` has to be told
    /// where its API lives.
    case environmentURLMissing(key: String)

    /// The build supplied a host, but it isn't a usable absolute URL.
    case environmentURLInvalid(key: String, value: String)

    /// `SecItemAdd` failed while storing an access token.
    case keychainWriteFailed(status: OSStatus)

    /// `SecItemCopyMatching` returned data that wasn't a UTF-8 string, or
    /// failed for a reason other than "no item" (that case returns `nil`,
    /// not an error).
    case keychainReadFailed(status: OSStatus)

    /// `SecItemDelete` failed for a reason other than "no item" (that case
    /// is treated as already-deleted, not an error).
    case keychainDeleteFailed(status: OSStatus)
}

extension OSNKitError: CustomStringConvertible {
    public var description: String {
        switch self {
        case .appGroupContainerUnavailable(let groupIdentifier):
            return "App Group container unavailable for \(groupIdentifier) — the entitlement is missing from this target, or the build is signed by a team the group isn't registered under. Cross-app session sharing does not exist until this is fixed."
        case .sessionCookieNotPersisted(let name, let host):
            return "Expected cookie \(name) for \(host) to be in the shared jar after a successful /token response, but it isn't. Check the URLSession is the shared one, and that the cookie name matches this environment's `secure` setting."
        case .refreshUnsupportedGrantType:
            return "POST /token rejected the grant_type this client sent (unsupported_grant_type) — client/server contract mismatch."
        case .refreshCookieMissing:
            return "POST /token returned invalid_request: no session cookie arrived on the request. This is a cookie-jar bug, not an expired session."
        case .refreshSessionInvalid(let message):
            return "POST /token returned invalid_grant: \(message). The session is gone; sign the user out."
        case .refreshResponseMalformed(let status):
            return "POST /token returned an unrecognized response (status \(status)). Refusing to treat it as success."
        case .deploymentTierMissing(let key):
            return "No \(key) in Info.plist. Each app's project.yml writes it per build configuration; this build has none, so there is no way to tell which tier it should talk to. Refusing to guess."
        case .deploymentTierUnknown(let value):
            return "Info.plist names an unknown tier: \(value). Expected one of \(DeploymentTier.allCases.map(\.rawValue).joined(separator: ", "))."
        case .environmentURLMissing(let key):
            return "No \(key) in Info.plist, and this tier has no fixed host to fall back to. Set it in the app's project.yml for this build configuration."
        case .environmentURLInvalid(let key, let value):
            return "\(key) in Info.plist is not a usable absolute URL: \(value)."
        case .keychainWriteFailed(let status):
            return "Keychain write failed (OSStatus \(status)) while storing the access token."
        case .keychainReadFailed(let status):
            return "Keychain read failed (OSStatus \(status)) while loading the access token."
        case .keychainDeleteFailed(let status):
            return "Keychain delete failed (OSStatus \(status)) while clearing the access token."
        }
    }
}
