import AuthenticationServices
import Foundation

/// Trap 5 — the controller needs an `ASPresentationAnchor`; this library
/// must not reach for a key window itself. Callers supply one at the call
/// site.
public typealias PresentationAnchorProvider = @Sendable () -> ASPresentationAnchor

enum PasskeyCeremony {
    /// `ASAuthorizationControllerPresentationContextProviding` is
    /// main-actor-isolated, which under Swift 6 propagates to the whole
    /// `PasskeyCeremonyRunner` class (including its synchronous `init`) by
    /// global-actor inference. This entry point stays `@MainActor` so it can
    /// construct and drive the runner without an actor hop; callers just
    /// `await` it like any other async API.
    @MainActor
    static func perform(
        requests: [ASAuthorizationRequest],
        anchorProvider: @escaping PresentationAnchorProvider
    ) async throws -> ASAuthorization {
        let runner = PasskeyCeremonyRunner(anchorProvider: anchorProvider)
        return try await runner.run(requests: requests)
    }
}

/// Bridges `ASAuthorizationController`'s delegate API to async/await.
///
/// Two lifetime hazards, both closed here:
/// - Trap 1 (double-resume): both delegate callbacks can fire in edge cases
///   (cancel racing completion). `SingleResumeContinuation` makes a second
///   resume a no-op instead of a crash.
/// - `ASAuthorizationController.delegate` is `weak` — and the controller
///   itself is created inside the `withCheckedThrowingContinuation` closure
///   as a local that would otherwise be deallocated the instant that
///   closure returns, before the ceremony completes. Both the controller and
///   this runner are held as strong properties/locals for the whole async
///   call so neither disappears mid-ceremony.
final class PasskeyCeremonyRunner: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding
{
    private let anchorProvider: PresentationAnchorProvider
    private var guarded: SingleResumeContinuation<ASAuthorization, Error>?
    private var controller: ASAuthorizationController?

    init(anchorProvider: @escaping PresentationAnchorProvider) {
        self.anchorProvider = anchorProvider
    }

    func run(requests: [ASAuthorizationRequest]) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { continuation in
            let guarded = SingleResumeContinuation(continuation)
            self.guarded = guarded
            let controller = ASAuthorizationController(authorizationRequests: requests)
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            controller.performRequests()
        }
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guarded?.resume(returning: authorization)
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        // Trap 2: map to PasskeyCeremonyError.cancelled right at the source
        // so cancellation never reaches a caller looking like a real error.
        guarded?.resume(throwing: PasskeyCeremonyError.map(error))
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        anchorProvider()
    }
}
