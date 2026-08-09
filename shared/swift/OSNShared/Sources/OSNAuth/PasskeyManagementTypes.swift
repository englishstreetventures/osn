import Foundation

/// `osn/api/src/services/auth/types.ts` — `PasskeySummary`.
public struct PasskeySummary: Sendable, Equatable, Decodable {
    public let id: String
    public let label: String?
    public let aaguid: String?
    public let transports: [String]?
    public let backupEligible: Bool?
    public let backupState: Bool?
    /// Unix seconds.
    public let createdAt: Int
    public let lastUsedAt: Int?
}

struct PasskeyListResponse: Decodable {
    let passkeys: [PasskeySummary]
}

/// `PATCH /passkeys/:id` success body — `{ "success": true }` and nothing
/// else (`osn/api/src/routes/auth/passkey-management.ts:84`). The updated
/// summary is deliberately not echoed back.
struct PasskeyRenameResult: Decodable {
    let success: Bool
}

/// `DELETE /passkeys/:id` success body
/// (`osn/api/src/routes/auth/passkey-management.ts:98`).
public struct PasskeyDeleteResult: Sendable, Equatable, Decodable {
    public let success: Bool
    public let remaining: Int
}

struct RenameRequestBody: Encodable {
    let label: String
}
