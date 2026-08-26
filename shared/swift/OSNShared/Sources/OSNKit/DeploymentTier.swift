import Foundation

/// How a tier resolver reads the app's `Info.plist`.
///
/// A closure rather than a `Bundle`, for the same reason
/// `SharedCookieJar.makeConfiguration` takes a `containerURLProvider`: a test
/// cannot construct a `Bundle` with an arbitrary info dictionary, so without
/// this seam none of the failure branches below could be reached from
/// `swift test`. Production callers use `.main` and never pass anything.
public struct InfoDictionaryLookup: Sendable {
    private let read: @Sendable (String) -> Any?

    public init(_ read: @escaping @Sendable (String) -> Any?) {
        self.read = read
    }

    public func callAsFunction(_ key: String) -> Any? { read(key) }

    /// The running app's own `Info.plist`.
    public static let main = InfoDictionaryLookup { Bundle.main.object(forInfoDictionaryKey: $0) }

    /// A fixed dictionary — for tests, and for nothing else.
    public static func fixture(_ values: [String: String]) -> InfoDictionaryLookup {
        InfoDictionaryLookup { values[$0] }
    }
}

/// Which deployed tier this build talks to. Mirrors `DeploymentEnvironment` in
/// `@shared/observability`, so the four names mean the same thing on both
/// sides of the wire.
///
/// The value comes from the app's `Info.plist`, written per build
/// configuration by XcodeGen (`OSNTier` in each app's `project.yml`). It is
/// read once, at the point a session is built — nothing caches it.
public enum DeploymentTier: String, Sendable, Equatable, CaseIterable {
    case local
    case dev
    case staging
    case production

    /// The `Info.plist` key each app's `project.yml` writes.
    public static let infoPlistKey = "OSNTier"

    /// - Throws: `OSNKitError.deploymentTierMissing` when the key is absent —
    ///   which means the app target was built without the per-configuration
    ///   setting, not that the user did anything wrong — or
    ///   `OSNKitError.deploymentTierUnknown` when it holds something outside
    ///   the four names above.
    ///
    ///   Deliberately no default. A build whose tier cannot be read must fail
    ///   loudly: the quiet alternative is a release that talks to `localhost`,
    ///   which is the exact bug this type exists to prevent.
    public static func resolve(info: InfoDictionaryLookup = .main) throws -> DeploymentTier {
        guard let raw = info(infoPlistKey) as? String, !raw.isEmpty else {
            throw OSNKitError.deploymentTierMissing(key: infoPlistKey)
        }
        guard let tier = DeploymentTier(rawValue: raw) else {
            throw OSNKitError.deploymentTierUnknown(value: raw)
        }
        return tier
    }
}

/// Reads a required URL out of the app's `Info.plist`.
///
/// Shared by `Environment` and `PulseEnvironment` — which live in different
/// modules — so both spell "this tier needs a host and the build did not
/// supply one" the same way.
public func osnRequiredURL(forInfoDictionaryKey key: String, in info: InfoDictionaryLookup = .main) throws -> URL {
    guard let raw = info(key) as? String, !raw.isEmpty else {
        throw OSNKitError.environmentURLMissing(key: key)
    }
    guard let url = URL(string: raw), url.scheme != nil, url.host != nil else {
        throw OSNKitError.environmentURLInvalid(key: key, value: raw)
    }
    return url
}
