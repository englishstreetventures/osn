import AuthenticationServices
import Foundation
import Testing
@testable import OSNAuth

/// Trap 2: cancellation is not failure — `ASAuthorizationError.canceled` must
/// map to its own case so the UI can silently ignore it rather than showing
/// an error (A5 depends on this).
struct PasskeyCeremonyErrorTests {
    @Test func cancelledErrorMapsToItsOwnCase() {
        let error = NSError(domain: ASAuthorizationError.errorDomain, code: ASAuthorizationError.canceled.rawValue)
        let mapped = PasskeyCeremonyError.map(error)
        guard case .cancelled = mapped else {
            Issue.record("expected .cancelled, got \(mapped)")
            return
        }
    }

    @Test func otherErrorsMapToUnderlying() {
        let error = NSError(domain: ASAuthorizationError.errorDomain, code: ASAuthorizationError.failed.rawValue)
        let mapped = PasskeyCeremonyError.map(error)
        guard case .underlying = mapped else {
            Issue.record("expected .underlying, got \(mapped)")
            return
        }
    }

    @Test func unrelatedErrorDomainMapsToUnderlying() {
        let error = NSError(domain: URLError.errorDomain, code: URLError.notConnectedToInternet.rawValue)
        let mapped = PasskeyCeremonyError.map(error)
        guard case .underlying = mapped else {
            Issue.record("expected .underlying, got \(mapped)")
            return
        }
    }
}
