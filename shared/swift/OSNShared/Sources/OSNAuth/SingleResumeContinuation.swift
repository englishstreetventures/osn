import Foundation

/// Trap 1: `ASAuthorizationController`'s delegate can fire twice in edge
/// cases (cancel racing completion) — resuming a `CheckedContinuation` twice
/// is a hard crash, not a catchable error. This wraps one continuation so
/// only the first `resume` call takes effect; every later call is a no-op.
final class SingleResumeContinuation<T, Failure: Error>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Failure>?

    init(_ continuation: CheckedContinuation<T, Failure>) {
        self.continuation = continuation
    }

    func resume(returning value: sending T) {
        take()?.resume(returning: value)
    }

    func resume(throwing error: Failure) {
        take()?.resume(throwing: error)
    }

    private func take() -> CheckedContinuation<T, Failure>? {
        lock.lock()
        defer { lock.unlock() }
        let current = continuation
        continuation = nil
        return current
    }
}
