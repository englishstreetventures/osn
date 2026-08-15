import Foundation

/// The App Group the shared session cookie jar lives in, so Pulse, Musubi,
/// and any later OSN app see the same HttpOnly session cookie. Named in
/// exactly one place — nothing else in `OSNShared` should hardcode it.
///
/// Registered in the Apple developer portal under team FV59Y8RSUH, so the
/// container resolves on device and `makeConfiguration` returns a real shared
/// jar. It still throws `OSNKitError.appGroupContainerUnavailable` where the
/// container is absent — an app target missing the
/// `com.apple.security.application-groups` entitlement, or a build signed by
/// another team. Both are the loud failure we want, not a jar that silently
/// shares with nobody.
public let osnSessionAppGroupIdentifier = "group.social.musubi.session"

public enum SharedCookieJar {
    /// Builds a `URLSessionConfiguration` backed by the App Group's shared
    /// `HTTPCookieStorage`.
    ///
    /// `HTTPCookieStorage.sharedCookieStorage(forGroupContainerIdentifier:)`
    /// does not fail when the App Group container doesn't exist — it hands
    /// back storage that looks usable but never actually shares with
    /// another process, which only surfaces once two apps compare notes.
    /// This checks `FileManager.containerURL` first and throws loudly
    /// instead (brief deliverable 4, door 2).
    /// `containerURLProvider` exists so tests can force the unavailable
    /// branch deterministically — on a real device/simulator,
    /// `FileManager.containerURL` for an unregistered or unentitled App
    /// Group is the only way to observe it, and that isn't reliable to
    /// assert on from `swift test` (an unsandboxed host process can resolve
    /// the path even without the entitlement). Callers outside tests never
    /// need to pass this.
    public static func makeConfiguration(
        groupIdentifier: String = osnSessionAppGroupIdentifier,
        containerURLProvider: (String) -> URL? = { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) }
    ) throws -> URLSessionConfiguration {
        guard containerURLProvider(groupIdentifier) != nil else {
            throw OSNKitError.appGroupContainerUnavailable(groupIdentifier: groupIdentifier)
        }
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = HTTPCookieStorage.sharedCookieStorage(forGroupContainerIdentifier: groupIdentifier)
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        return configuration
    }

    /// Convenience wrapper — a `URLSession` built on `makeConfiguration`'s
    /// shared jar.
    public static func makeSession(groupIdentifier: String = osnSessionAppGroupIdentifier) throws -> URLSession {
        URLSession(configuration: try makeConfiguration(groupIdentifier: groupIdentifier))
    }
}
