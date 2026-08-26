import Foundation

/// The four-tier deployment model shared across OSN (mirrors
/// `DeploymentEnvironment` in `@shared/observability`): local, dev,
/// staging, production.
///
/// `local` and `production` have a real, deployed osn-api host and so
/// resolve to a fixed URL. `dev` and `staging` have no deployed osn-api
/// host yet (CLAUDE.md: only local and `id.musubi.social` are live), so
/// their base URL is supplied by the caller rather than guessed.
public enum Environment: Sendable, Equatable {
    case local
    case dev(baseURL: URL)
    case staging(baseURL: URL)
    case production

    public var baseURL: URL {
        switch self {
        case .local:
            return URL(string: "http://localhost:4000")!
        case .dev(let baseURL), .staging(let baseURL):
            return baseURL
        case .production:
            return URL(string: "https://id.musubi.social")!
        }
    }

    /// The `Info.plist` key carrying the issuer host for tiers that have no
    /// fixed one.
    public static let issuerURLInfoPlistKey = "OSNIssuerURL"

    /// Builds the environment this app was compiled for, from the `OSNTier`
    /// its build configuration wrote into `Info.plist`.
    ///
    /// `local` and `production` resolve to their fixed hosts. `dev` and
    /// `staging` have no deployed osn-api host, so they take theirs from
    /// `OSNIssuerURL` and throw when the build did not supply one.
    ///
    /// - Throws: `OSNKitError.deploymentTierMissing` / `.deploymentTierUnknown`
    ///   / `.environmentURLMissing` / `.environmentURLInvalid`. All four are
    ///   build-configuration faults, and all four are deliberately loud — the
    ///   alternative is a release build quietly talking to `localhost`, which
    ///   is what this method exists to make impossible.
    public static func resolve(info: InfoDictionaryLookup = .main) throws -> Environment {
        switch try DeploymentTier.resolve(info: info) {
        case .local:
            return .local
        case .dev:
            return .dev(baseURL: try osnRequiredURL(forInfoDictionaryKey: issuerURLInfoPlistKey, in: info))
        case .staging:
            return .staging(baseURL: try osnRequiredURL(forInfoDictionaryKey: issuerURLInfoPlistKey, in: info))
        case .production:
            return .production
        }
    }
}
