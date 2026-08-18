import Foundation

/// The subset of an access-token JWT's payload claims this package reads —
/// `osn/api/src/services/auth/tokens.ts` `issueAccessToken` mints `sub`,
/// `aud`, `email`, `handle`, and an optional `displayName` (`accountId` is
/// deliberately absent, the P6 invariant). `aud` and `scope` aren't decoded
/// here because nothing on this side branches on them.
///
/// **This does not verify the signature and is not a trust boundary.** It
/// exists only to notice that the token now sitting in the Keychain belongs
/// to someone else, so a stale cached profile can be dropped — see
/// `reconciledProfile(cached:claims:)`. Every authorisation decision still
/// happens server-side, which verifies the ES256 signature
/// (`verifyAccessToken`). A forged token gets a caller nothing here: it is
/// rejected by the API on the next request that actually needs it.
public struct AccessTokenClaims: Sendable, Equatable, Decodable {
    public let sub: String
    public let email: String
    public let handle: String
    public let displayName: String?

    /// Splits `jwt` on `"."`, requiring exactly 3 segments, base64url-decodes
    /// the middle one, and `JSONDecoder`s it. Any failure — wrong segment
    /// count, non-base64url text, valid base64url that isn't JSON, JSON
    /// missing a required claim — returns `nil`. Never throws, never traps.
    /// Unknown claims (`aud`, `scope`, `osn_sid`, …) are ignored by
    /// `Decodable`'s default behaviour.
    public init?(jwt: String) {
        let segments = jwt.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count == 3,
            let payloadData = Base64URL.decode(String(segments[1])),
            let claims = try? JSONDecoder().decode(AccessTokenClaims.self, from: payloadData)
        else {
            return nil
        }
        self = claims
    }
}
