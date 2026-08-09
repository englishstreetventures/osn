import Foundation
import Security

/// Stores the access token only — never the session cookie value, which
/// stays HttpOnly and lives in `SharedCookieJar`'s cookie storage. One item,
/// overwritten on every refresh; there's exactly one "current" access token
/// per app process, so no per-environment or per-account keying.
public enum KeychainAccessTokenStore {
    private static let service = "OSNKit.accessToken"
    private static let account = "current"

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
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
