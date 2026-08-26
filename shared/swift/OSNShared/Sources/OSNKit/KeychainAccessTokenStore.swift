import Foundation
import Security

/// Stores the access token only — never the session cookie value, which
/// stays HttpOnly and lives in `SharedCookieJar`'s cookie storage. One item,
/// overwritten on every refresh; there's exactly one "current" access token
/// per app process, so no per-environment or per-account keying.
public enum KeychainAccessTokenStore {
    private static let service = "OSNKit.accessToken"
    private static let account = "current"

    /// The Keychain access group the item lives in, or `nil` for an
    /// app-private item.
    ///
    /// Without a group each app gets its **own** item, so signing out of Pulse
    /// left Musubi's copy of the access token working for the rest of its
    /// ≤5-minute TTL even though the shared session was already dead. iOS
    /// accepts an App Group identifier here given the App Groups entitlement
    /// both targets already declare, so this needs no new entitlement and no
    /// provisioning-profile regeneration.
    ///
    /// `nil` off iOS, and that is not a detail: `swift test` runs on an
    /// unentitled macOS host, and an unentitled process that asks for an
    /// access group gets `errSecMissingEntitlement` (−34018) on *every* call.
    /// Four test targets write to the real Keychain, so a hardcoded group
    /// would turn the whole suite red. It is a `var` so a test can force
    /// either branch.
    #if os(iOS)
    public nonisolated(unsafe) static var accessGroup: String? = osnSessionAppGroupIdentifier
    #else
    public nonisolated(unsafe) static var accessGroup: String? = nil
    #endif

    /// Moves a pre-existing app-private item into the shared access group,
    /// once.
    ///
    /// Called from `OSNSession`'s initializer, which is the one place every
    /// app builds a session, so an app updating from a build that predates
    /// group sharing keeps its signed-in state instead of being silently
    /// logged out.
    ///
    /// Idempotent by construction: it reads the ungrouped item first and
    /// returns immediately when there is none, so a second run does nothing
    /// rather than raising `errSecDuplicateItem` (−25299). A no-op when
    /// `accessGroup` is `nil` — there is nowhere to migrate to.
    public static func migrateToSharedAccessGroup() throws {
        guard accessGroup != nil else { return }

        // Named `legacyQuery`, not `query`: a local called `query` would shadow
        // the `query(accessGroup:)` above, and the later call to it would
        // resolve to the dictionary instead of the function.
        let legacyQuery = query(accessGroup: nil)

        var readQuery = legacyQuery
        readQuery[kSecReturnData as String] = true
        readQuery[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(readQuery as CFDictionary, &result)
        switch status {
        case errSecItemNotFound:
            return
        case errSecSuccess:
            break
        default:
            throw OSNKitError.keychainReadFailed(status: status)
        }
        guard let data = result as? Data else {
            throw OSNKitError.keychainReadFailed(status: status)
        }

        // Write the grouped copy before dropping the original: a failure
        // halfway leaves the user signed in rather than signed out.
        SecItemDelete(baseQuery() as CFDictionary)
        var write = baseQuery()
        write[kSecValueData as String] = data
        write[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let writeStatus = SecItemAdd(write as CFDictionary, nil)
        guard writeStatus == errSecSuccess else {
            throw OSNKitError.keychainWriteFailed(status: writeStatus)
        }

        let deleteStatus = SecItemDelete(legacyQuery as CFDictionary)
        guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else {
            throw OSNKitError.keychainDeleteFailed(status: deleteStatus)
        }
    }

    /// A cached access token plus the moment it expires, so callers can
    /// judge freshness without a second round trip to the server.
    public struct StoredAccessToken: Sendable, Equatable {
        public let token: String
        public let expiresAt: Date
    }

    private struct Payload: Codable {
        let token: String
        let expiresAt: Date
    }

    /// Overwrites any existing stored token. `expiresIn` is the server's
    /// `expires_in` (seconds from now), from the `/token` response.
    public static func save(_ token: String, expiresIn: TimeInterval) throws {
        let payload = Payload(token: token, expiresAt: Date().addingTimeInterval(expiresIn))
        let data = try JSONEncoder().encode(payload)
        SecItemDelete(baseQuery() as CFDictionary)
        var query = baseQuery()
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw OSNKitError.keychainWriteFailed(status: status)
        }
    }

    /// `nil` when no token is stored — that's a normal state (signed out),
    /// not an error.
    public static func load() throws -> StoredAccessToken? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data,
                let payload = try? JSONDecoder().decode(Payload.self, from: data)
            else {
                throw OSNKitError.keychainReadFailed(status: status)
            }
            return StoredAccessToken(token: payload.token, expiresAt: payload.expiresAt)
        case errSecItemNotFound:
            return nil
        default:
            throw OSNKitError.keychainReadFailed(status: status)
        }
    }

    public static func delete() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw OSNKitError.keychainDeleteFailed(status: status)
        }
    }

    private static func baseQuery() -> [String: Any] {
        query(accessGroup: accessGroup)
    }

    private static func query(accessGroup: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }
}
