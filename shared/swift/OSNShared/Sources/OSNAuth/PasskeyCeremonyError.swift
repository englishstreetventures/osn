import AuthenticationServices
import Foundation

/// Trap 2: cancellation is not failure. `ASAuthorizationError.canceled` (the
/// user tapping away) must surface as its own case a caller can ignore
/// silently, never as an error to show.
public enum PasskeyCeremonyError: Error, Sendable {
    case cancelled
    case underlying(Error)

    public static func map(_ error: Error) -> PasskeyCeremonyError {
        let nsError = error as NSError
        if nsError.domain == ASAuthorizationError.errorDomain,
           nsError.code == ASAuthorizationError.canceled.rawValue {
            return .cancelled
        }
        return .underlying(error)
    }
}
