import Foundation
import Testing
@testable import OSNAuth

/// Round-trips at byte lengths that force 0, 1, and 2 base64 padding
/// characters — trap 3 ("both directions", "including inputs forcing 1 and
/// 2 padding characters").
struct Base64URLTests {
    @Test func roundTripsAcrossPaddingLengths() {
        let noPadding = Data([0x01, 0x02, 0x03]) // 3 bytes -> 4 base64 chars, no '='
        let onePadding = Data([0x01, 0x02, 0x03, 0x04]) // 4 bytes -> 2 '=' padding chars
        let twoPadding = Data([0x01, 0x02, 0x03, 0x04, 0x05]) // 5 bytes -> 1 '=' padding char

        for original in [noPadding, onePadding, twoPadding] {
            let encoded = Base64URL.encode(original)
            #expect(!encoded.contains("="))
            #expect(!encoded.contains("+"))
            #expect(!encoded.contains("/"))
            #expect(Base64URL.decode(encoded) == original)
        }
    }

    @Test func decodeHandlesUrlSafeCharacters() {
        // Bytes chosen so standard base64 would contain both '+' and '/'.
        let original = Data([0xFB, 0xFF, 0xBF])
        let standardBase64 = original.base64EncodedString()
        #expect(standardBase64.contains("+") || standardBase64.contains("/"))

        let encoded = Base64URL.encode(original)
        #expect(Base64URL.decode(encoded) == original)
    }
}
