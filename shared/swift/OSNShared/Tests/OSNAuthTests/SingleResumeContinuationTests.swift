import Testing
@testable import OSNAuth

/// Trap 1: double-resume of a bridged `ASAuthorizationController` delegate
/// callback is a hard crash. A second `resume` call that survives (rather
/// than crashing the process) is proof the guard works — the awaited value
/// must still be the first one delivered.
struct SingleResumeContinuationTests {
    @Test func secondReturningResumeIsIgnored() async {
        let result = await withCheckedContinuation { (continuation: CheckedContinuation<Int, Never>) in
            let guarded = SingleResumeContinuation(continuation)
            guarded.resume(returning: 1)
            guarded.resume(returning: 2)
        }
        #expect(result == 1)
    }

    @Test func throwingResumeAfterReturningResumeIsIgnored() async throws {
        struct Marker: Error {}
        let result = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int, Error>) in
            let guarded = SingleResumeContinuation(continuation)
            guarded.resume(returning: 1)
            guarded.resume(throwing: Marker())
        }
        #expect(result == 1)
    }
}
