import Foundation

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
}
