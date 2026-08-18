import Foundation
import Testing
@testable import OSNAuth

/// Same fixture-building approach as `AccessTokenClaimsTests` — real JSON
/// through `Base64URL.encode`, decoded back via `AccessTokenClaims.init?(jwt:)`,
/// rather than constructing `AccessTokenClaims` any other way (it has no
/// other initializer).
private func makeClaims(sub: String, email: String = "a@example.com", handle: String = "alice", displayName: String? = nil) -> AccessTokenClaims {
    let header = Base64URL.encode(Data(#"{"alg":"ES256","typ":"JWT"}"#.utf8))
    var payloadObject = ["sub": sub, "email": email, "handle": handle]
    if let displayName {
        payloadObject["displayName"] = displayName
    }
    let payloadData = try! JSONSerialization.data(withJSONObject: payloadObject)
    let payload = Base64URL.encode(payloadData)
    let signature = Base64URL.encode(Data([0x01, 0x02, 0x03]))
    let jwt = "\(header).\(payload).\(signature)"
    return AccessTokenClaims(jwt: jwt)!
}

/// Covers the four branches of `reconciledProfile(cached:claims:)` — the
/// pure reconciliation seam S-H1 hangs everything else off.
struct ReconciledProfileTests {
    @Test func nilClaimsAlwaysReturnsNilEvenWithACachedProfile() {
        let cached = PasskeyProfile(id: "profile-a", handle: "alice", email: "a@example.com", displayName: nil, avatarUrl: "https://example.com/a.png")

        #expect(reconciledProfile(cached: cached, claims: nil) == nil)
        #expect(reconciledProfile(cached: nil, claims: nil) == nil)
    }

    @Test func matchingIdPreservesCachedProfileIncludingAvatarUrl() {
        let cached = PasskeyProfile(id: "profile-a", handle: "alice", email: "a@example.com", displayName: "Alice", avatarUrl: "https://example.com/a.png")
        let claims = makeClaims(sub: "profile-a", email: "a-new@example.com", handle: "alice-new", displayName: "Alice New")

        let reconciled = reconciledProfile(cached: cached, claims: claims)

        // The cached value wins verbatim — including fields the token
        // disagrees with, and `avatarUrl`, which claims cannot supply.
        #expect(reconciled == cached)
        #expect(reconciled?.avatarUrl == "https://example.com/a.png")
    }

    @Test func differingIdReplacesCachedProfileAndClearsAvatarUrl() {
        let cached = PasskeyProfile(id: "profile-a", handle: "alice", email: "a@example.com", displayName: "Alice", avatarUrl: "https://example.com/a.png")
        let claims = makeClaims(sub: "profile-b", email: "b@example.com", handle: "bob", displayName: "Bob")

        let reconciled = reconciledProfile(cached: cached, claims: claims)

        #expect(reconciled?.id == "profile-b")
        #expect(reconciled?.handle == "bob")
        #expect(reconciled?.email == "b@example.com")
        #expect(reconciled?.displayName == "Bob")
        #expect(reconciled?.avatarUrl == nil)
    }

    @Test func noCachedProfileBuildsFreshOneFromClaims() {
        let claims = makeClaims(sub: "profile-b", email: "b@example.com", handle: "bob", displayName: nil)

        let reconciled = reconciledProfile(cached: nil, claims: claims)

        #expect(reconciled?.id == "profile-b")
        #expect(reconciled?.displayName == nil)
        #expect(reconciled?.avatarUrl == nil)
    }
}
