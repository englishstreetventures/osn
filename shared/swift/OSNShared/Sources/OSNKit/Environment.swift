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
}
