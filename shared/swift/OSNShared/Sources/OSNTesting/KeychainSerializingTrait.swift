import Testing

/// Serializes any test carrying this trait against every other test carrying
/// it, even across suites and test targets. `@Suite(.serialized)` only
/// orders tests *within* one suite — Swift Testing still runs different
/// suites (and different test targets, e.g. `OSNKitTests` vs `PulseAPITests`)
/// concurrently in the same `swift test` process. `OSNKitTests`'
/// `KeychainSerialTests` and `PulseAPITests`' `BearerTokenMiddlewareTests`
/// both read/write the one physical `KeychainAccessTokenStore` item, so
/// without this they race: concurrent `SecItemAdd`/`SecItemDelete` calls
/// produce `OSStatus -25299` (duplicate item), and interleaved writes
/// invalidate each other's "current value" assertions.
public struct KeychainSerializingTrait: SuiteTrait, TestTrait, TestScoping {
    public func provideScope(
        for test: Test,
        testCase: Test.Case?,
        performing function: @Sendable () async throws -> Void
    ) async throws {
        await KeychainLock.shared.lock()
        do {
            try await function()
        } catch {
            await KeychainLock.shared.unlock()
            throw error
        }
        await KeychainLock.shared.unlock()
    }
}

extension Trait where Self == KeychainSerializingTrait {
    public static var keychainSerializing: Self { Self() }
}

/// A plain FIFO async mutex. `lock()` only suspends when contended — the
/// uncontended path returns immediately without a continuation.
private actor KeychainLock {
    static let shared = KeychainLock()

    private var isLocked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func lock() async {
        if !isLocked {
            isLocked = true
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    func unlock() {
        guard !waiters.isEmpty else {
            isLocked = false
            return
        }
        waiters.removeFirst().resume()
    }
}
