import Foundation
import OSNTesting
import Testing
@testable import OSNKit

// One Keychain item backs the whole store, so every test that touches it —
// here, in TokenRefresherTests.swift, and in PulseAPITests'
// BearerTokenMiddlewareTests — runs as an ordered step inside this one
// serialized suite rather than as independent @Test funcs. Swift Testing
// runs tests concurrently by default, and concurrent saves/deletes against
// the same Keychain item race (duplicate-item and entitlement errors that
// are artifacts of the race, not of the store). `.keychainSerializing`
// extends that ordering across suites and test targets — `.serialized`
// alone only orders tests within this one suite.
@Suite(.serialized, .keychainSerializing)
struct KeychainSerialTests {
    @Test func keychainAccessTokenStoreRoundTrips() throws {
        try KeychainAccessTokenStore.delete()
        #expect(try KeychainAccessTokenStore.load() == nil)

        try KeychainAccessTokenStore.save("token-a", expiresIn: 300)
        let stored = try KeychainAccessTokenStore.load()
        #expect(stored?.token == "token-a")
        #expect(stored?.expiresAt.timeIntervalSinceNow ?? 0 > 250)

        try KeychainAccessTokenStore.save("token-b", expiresIn: 60)
        #expect(try KeychainAccessTokenStore.load()?.token == "token-b")

        try KeychainAccessTokenStore.delete()
        #expect(try KeychainAccessTokenStore.load() == nil)

        try KeychainAccessTokenStore.delete()
        #expect(try KeychainAccessTokenStore.load() == nil)
    }
}

extension KeychainSerialTests {
    /// The migration's reachable branch on this host.
    ///
    /// `accessGroup` is `nil` off iOS — an unentitled macOS process asking for
    /// `kSecAttrAccessGroup` gets `errSecMissingEntitlement` (−34018) on every
    /// call, which would turn all four Keychain-touching test targets red — so
    /// the only branch `swift test` can execute is the early return. What it
    /// does prove is that the migration is harmless where it cannot apply, and
    /// that it never disturbs a stored token: the actual move between groups is
    /// device-only and is verified by hand.
    @Test func migrationIsANoOpWithNoAccessGroupConfigured() throws {
        #expect(KeychainAccessTokenStore.accessGroup == nil, "off iOS this must stay nil, or the suite cannot run")

        try KeychainAccessTokenStore.delete()
        try KeychainAccessTokenStore.save("token-before", expiresIn: 300)

        try KeychainAccessTokenStore.migrateToSharedAccessGroup()
        #expect(try KeychainAccessTokenStore.load()?.token == "token-before")

        // Idempotent: running it again changes nothing and raises nothing.
        try KeychainAccessTokenStore.migrateToSharedAccessGroup()
        #expect(try KeychainAccessTokenStore.load()?.token == "token-before")

        try KeychainAccessTokenStore.delete()
    }
}
