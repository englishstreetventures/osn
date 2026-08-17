import AuthenticationServices
import Foundation

/// Trap 5 — the controller needs an `ASPresentationAnchor`; this library
/// must not reach for a key window itself. Callers supply one at the call
/// site.
///
/// `@MainActor`, because the only thing that can answer it is a key-window
/// lookup (`UIApplication.shared`), which is main-actor-isolated. Without the
/// annotation an app-side provider has to be declared `@Sendable` on a method
/// the compiler already infers as main-actor-isolated, which Swift 6 rejects
/// outright. `@Sendable` stays so the value can still cross into
/// non-isolated storage before it's called.
public typealias PresentationAnchorProvider = @MainActor @Sendable () -> ASPresentationAnchor

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
/// Brief T3 §2 — the handle a caller keeps to cancel a still-running
/// ceremony. `PasskeyCeremony.perform` above is untouched: the modal path
/// is fire-and-forget and has never needed cancellation. Autofill does,
/// since a `.task`-armed request can outlive the view that started it.
@MainActor
final class PasskeyCeremonyHandle {
    private let runner: PasskeyCeremonyRunner
    private let requests: [ASAuthorizationRequest]
    private let autoFill: Bool

    init(requests: [ASAuthorizationRequest], autoFill: Bool = false, anchorProvider: @escaping PresentationAnchorProvider) {
        runner = PasskeyCeremonyRunner(anchorProvider: anchorProvider)
        self.requests = requests
        self.autoFill = autoFill
    }

    func result() async throws -> ASAuthorization {
        try await runner.run(requests: requests, autoFill: autoFill)
    }

    func cancel() {
        runner.cancel()
    }
}

final class PasskeyCeremonyRunner: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding
{
    private let anchorProvider: PresentationAnchorProvider
    private var guarded: SingleResumeContinuation<ASAuthorization, Error>?
    private var controller: ASAuthorizationController?

    init(anchorProvider: @escaping PresentationAnchorProvider) {
        self.anchorProvider = anchorProvider
    }

    /// `autoFill` arms `performAutoFillAssistedRequests()` (conditional UI,
    /// iOS-only — brief T3 §3) instead of the modal `performRequests()`.
    /// Default keeps `PasskeyCeremony.perform`'s existing call site
    /// (`runner.run(requests: requests)`) compiling unchanged.
    func run(requests: [ASAuthorizationRequest], autoFill: Bool = false) async throws -> ASAuthorization {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let guarded = SingleResumeContinuation(continuation)
                self.guarded = guarded
                let controller = ASAuthorizationController(authorizationRequests: requests)
                controller.delegate = self
                controller.presentationContextProvider = self
                self.controller = controller
                if autoFill {
                    #if os(iOS)
                    controller.performAutoFillAssistedRequests()
                    #else
                    preconditionFailure("performAutoFillAssistedRequests() does not exist on macOS")
                    #endif
                } else {
                    controller.performRequests()
                }
            }
        } onCancel: {
            // Brief T3 §2 — without this, a `.task`-started autofill whose
            // Task is cancelled on disappear awaits a continuation nothing
            // resumes and hangs forever. `SingleResumeContinuation` guards
            // double-resume, not never-resume. `onCancel` is `@Sendable` and
            // can run off the main actor, so hop back to call `cancel()`.
            Task { @MainActor in
                self.cancel()
            }
        }
    }

    /// Shared by `PasskeyCeremonyHandle.cancel()` (explicit) and the
    /// `onCancel` handler above (implicit Task cancellation).
    func cancel() {
        controller?.cancel()
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
