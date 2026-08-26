import Foundation
import OSNKit

/// Pulse's own base URL — a separate question from osn-api's `Environment`.
/// There is no deployed Pulse API host yet, so only `.local` may hardcode a
/// URL; every other case takes its base URL from the caller.
public enum PulseEnvironment: Sendable, Equatable {
    case local
    case dev(baseURL: URL)
    case staging(baseURL: URL)
    case production(baseURL: URL)

    public var baseURL: URL {
        switch self {
        case .local: return URL(string: "http://localhost:3001")!
        case .dev(let baseURL), .staging(let baseURL), .production(let baseURL): return baseURL
        }
    }

    /// The `Info.plist` key carrying the Pulse API host.
    public static let apiURLInfoPlistKey = "PulseAPIURL"

    /// Builds the Pulse environment this app was compiled for, from the same
    /// `OSNTier` key `Environment.resolve` reads.
    ///
    /// Only `local` has a fixed host. **No Pulse API host is deployed at any
    /// tier**, so every other tier takes its base URL from `PulseAPIURL` and
    /// throws when the build did not supply one.
    ///
    /// That throw is the point. Before this existed, `PulseSession.init`
    /// defaulted to `.local`, so a release build silently pointed at
    /// `http://localhost:3001` and simply never loaded anything. Failing here
    /// surfaces "Pulse has no server yet" through the app's existing
    /// `Text(sessionError)` path instead of hiding it as an empty feed.
    public static func resolve(info: InfoDictionaryLookup = .main) throws -> PulseEnvironment {
        switch try DeploymentTier.resolve(info: info) {
        case .local:
            return .local
        case .dev:
            return .dev(baseURL: try osnRequiredURL(forInfoDictionaryKey: apiURLInfoPlistKey, in: info))
        case .staging:
            return .staging(baseURL: try osnRequiredURL(forInfoDictionaryKey: apiURLInfoPlistKey, in: info))
        case .production:
            return .production(baseURL: try osnRequiredURL(forInfoDictionaryKey: apiURLInfoPlistKey, in: info))
        }
    }

}
