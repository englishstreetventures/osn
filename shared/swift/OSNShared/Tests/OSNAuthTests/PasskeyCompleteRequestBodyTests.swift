import Foundation
import Testing
@testable import OSNAuth

/// `/login/passkey/complete` requires exactly one of `identifier` /
/// `challengeId` on the wire — both or neither is a 400 (brief §2). Confirms
/// the enum-backed encoder actually omits the unused key rather than sending
/// it as `null`.
struct PasskeyCompleteRequestBodyTests {
    private func fixtureAssertion() -> AuthenticationResponseJSON {
        AuthenticationResponseJSON(
            id: "id",
            rawId: "rawId",
            authenticatorAttachment: "platform",
            response: AuthenticatorAssertionResponseJSON(
                clientDataJSON: "clientData",
                authenticatorData: "authData",
                signature: "sig",
                userHandle: nil
            )
        )
    }

    private func encodedKeys(_ body: PasskeyCompleteRequestBody) throws -> Set<String> {
        let data = try JSONEncoder().encode(body)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return Set((object?.keys).map(Array.init) ?? [])
    }

    @Test func identifierTargetOmitsChallengeId() throws {
        let body = PasskeyCompleteRequestBody(target: .identifier("someone"), assertion: fixtureAssertion())
        let keys = try encodedKeys(body)
        #expect(keys.contains("identifier"))
        #expect(!keys.contains("challengeId"))
    }

    @Test func challengeIdTargetOmitsIdentifier() throws {
        let body = PasskeyCompleteRequestBody(target: .challengeId("chal-1"), assertion: fixtureAssertion())
        let keys = try encodedKeys(body)
        #expect(keys.contains("challengeId"))
        #expect(!keys.contains("identifier"))
    }
}
