import Foundation
import Testing
@testable import OSNAuth

/// Builds a JWT-shaped string from real header/payload JSON via
/// `Base64URL.encode` — never an opaque literal blob — so a reader can see
/// exactly what each test decodes. The signature segment is arbitrary bytes:
/// `AccessTokenClaims.init?(jwt:)` never verifies it (see that type's doc).
private func makeJWT(payloadObject: [String: String]) -> String {
    let header = Base64URL.encode(Data(#"{"alg":"ES256","typ":"JWT"}"#.utf8))
    let payloadData = try! JSONSerialization.data(withJSONObject: payloadObject)
    let payload = Base64URL.encode(payloadData)
    let signature = Base64URL.encode(Data([0x01, 0x02, 0x03]))
    return "\(header).\(payload).\(signature)"
}

struct AccessTokenClaimsTests {
    @Test func validThreeSegmentJWTDecodesAllFourFields() {
        let jwt = makeJWT(payloadObject: [
            "sub": "profile-a",
            "email": "a@example.com",
            "handle": "alice",
            "displayName": "Alice A.",
            // Unknown claim, present on every real token — must not break decoding.
            "aud": "osn-access",
        ])

        let claims = AccessTokenClaims(jwt: jwt)
        #expect(claims?.sub == "profile-a")
        #expect(claims?.email == "a@example.com")
        #expect(claims?.handle == "alice")
        #expect(claims?.displayName == "Alice A.")
    }

    @Test func missingDisplayNameDecodesToNil() {
        let jwt = makeJWT(payloadObject: [
            "sub": "profile-a",
            "email": "a@example.com",
            "handle": "alice",
        ])

        let claims = AccessTokenClaims(jwt: jwt)
        #expect(claims != nil)
        #expect(claims?.displayName == nil)
    }

    @Test func unknownExtraClaimsAreIgnored() {
        let jwt = makeJWT(payloadObject: [
            "sub": "profile-a",
            "email": "a@example.com",
            "handle": "alice",
            "osn_sid": "session-abc",
            "scope": "openid profile",
        ])

        let claims = AccessTokenClaims(jwt: jwt)
        #expect(claims?.sub == "profile-a")
    }

    @Test func twoSegmentStringReturnsNil() {
        #expect(AccessTokenClaims(jwt: "onlyheader.onlypayload") == nil)
    }

    @Test func segmentThatIsNotBase64URLReturnsNil() {
        let header = Base64URL.encode(Data(#"{"alg":"ES256","typ":"JWT"}"#.utf8))
        let signature = Base64URL.encode(Data([0x01, 0x02, 0x03]))
        // "!" and " " are outside the base64url alphabet, so decoding the
        // middle segment must fail before JSON ever gets involved.
        let jwt = "\(header).not valid base64!!!.\(signature)"

        #expect(AccessTokenClaims(jwt: jwt) == nil)
    }

    @Test func segmentThatIsValidBase64URLButNotJSONReturnsNil() {
        let header = Base64URL.encode(Data(#"{"alg":"ES256","typ":"JWT"}"#.utf8))
        let signature = Base64URL.encode(Data([0x01, 0x02, 0x03]))
        let payload = Base64URL.encode(Data("hello world, not json".utf8))
        let jwt = "\(header).\(payload).\(signature)"

        #expect(AccessTokenClaims(jwt: jwt) == nil)
    }

    @Test func jsonMissingSubReturnsNil() {
        let jwt = makeJWT(payloadObject: [
            "email": "a@example.com",
            "handle": "alice",
        ])

        #expect(AccessTokenClaims(jwt: jwt) == nil)
    }

    @Test func emptyStringReturnsNil() {
        #expect(AccessTokenClaims(jwt: "") == nil)
    }
}
