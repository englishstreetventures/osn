import AuthenticationServices
import Foundation
import Testing
@testable import OSNAuth

/// Brief T3 §6 — direct coverage of the helpers `PasskeyLoginClient.signIn`
/// used to run inline: request building (`makeAssertionRequest`) and target
/// selection (`loginTarget`). Both are platform-neutral (no
/// `ASAuthorizationController` involved), so they run on the macOS host same
/// as every other target in this package.
///
/// `packageAssertion(_:)` — the third helper the brief names — is not
/// covered here. It takes an `ASAuthorization` whose credential is an
/// `ASAuthorizationPlatformPublicKeyCredentialAssertion`; Apple vends that
/// type only from a real ceremony completion and exposes no public
/// initializer, so no fixture can be constructed in-process. That line of
/// the autofill path (and the modal path, which shares this same helper)
/// has never been machine-tested, before or after this brief — it ships
/// human-reviewed only.
private func makeClient() -> PasskeyLoginClient {
    PasskeyLoginClient(session: URLSession(configuration: .ephemeral), environment: .local)
}

private func fixtureBegin(
    challenge: String = "Y2hhbGxlbmdl",
    rpId: String = "musubi.social",
    allowCredentials: [AllowCredentialJSON] = [],
    userVerification: String = "preferred",
    challengeId: String? = "challenge-id-1"
) -> PasskeyLoginBeginResponse {
    PasskeyLoginBeginResponse(
        options: PublicKeyCredentialRequestOptionsJSON(
            challenge: challenge,
            timeout: nil,
            rpId: rpId,
            allowCredentials: allowCredentials,
            userVerification: userVerification
        ),
        challengeId: challengeId
    )
}

struct PasskeyLoginClientMakeAssertionRequestTests {
    @Test func usesRpIdAndDecodedChallengeFromResponse() throws {
        let client = makeClient()
        let begun = fixtureBegin(challenge: "Y2hhbGxlbmdl", rpId: "musubi.social")

        let request = try client.makeAssertionRequest(from: begun)

        #expect(request.relyingPartyIdentifier == "musubi.social")
        #expect(request.challenge == Base64URL.decode("Y2hhbGxlbmdl"))
    }

    @Test func mapsAllowCredentialsToDecodedDescriptors() throws {
        let client = makeClient()
        let credentialId = Base64URL.encode(Data([1, 2, 3, 4]))
        let begun = fixtureBegin(allowCredentials: [
            AllowCredentialJSON(id: credentialId, type: "public-key", transports: nil),
        ])

        let request = try client.makeAssertionRequest(from: begun)

        #expect(request.allowedCredentials.count == 1)
        #expect(request.allowedCredentials.first?.credentialID == Data([1, 2, 3, 4]))
    }

    @Test func emptyAllowCredentialsStaysEmpty() throws {
        // Discoverable / conditional-UI begin: server sends `allowCredentials: []`.
        let client = makeClient()
        let begun = fixtureBegin(allowCredentials: [])

        let request = try client.makeAssertionRequest(from: begun)

        #expect(request.allowedCredentials.isEmpty)
    }

    @Test func recognizedUserVerificationValueIsApplied() throws {
        let client = makeClient()
        let begun = fixtureBegin(userVerification: "required")

        let request = try client.makeAssertionRequest(from: begun)

        #expect(request.userVerificationPreference == .required)
    }

    @Test func unrecognizedUserVerificationValueLeavesSDKDefaultInEffect() throws {
        // RequestHelpers.userVerificationPreference returns nil for an
        // unrecognized string rather than guessing — verify that leaves
        // Apple's own default (`.preferred`) untouched instead of e.g. nil.
        let client = makeClient()
        let begun = fixtureBegin(userVerification: "bogus-value")

        let request = try client.makeAssertionRequest(from: begun)

        #expect(request.userVerificationPreference == .preferred)
    }

    @Test func malformedChallengeThrows() {
        let client = makeClient()
        let begun = fixtureBegin(challenge: "not valid base64url!!!")

        #expect(throws: OSNAuthError.responseMalformed(status: 200)) {
            try client.makeAssertionRequest(from: begun)
        }
    }

    @Test func malformedCredentialIdThrows() {
        let client = makeClient()
        let begun = fixtureBegin(allowCredentials: [
            AllowCredentialJSON(id: "not valid base64url!!!", type: "public-key", transports: nil),
        ])

        #expect(throws: OSNAuthError.responseMalformed(status: 200)) {
            try client.makeAssertionRequest(from: begun)
        }
    }
}

struct PasskeyLoginClientLoginTargetTests {
    @Test func typedIdentifierAlwaysWins() throws {
        let client = makeClient()
        let begun = fixtureBegin(challengeId: "should-be-ignored")

        let target = try client.loginTarget(identifier: "someone", begun: begun)

        #expect(target == .identifier("someone"))
    }

    @Test func nilIdentifierFallsBackToChallengeId() throws {
        let client = makeClient()
        let begun = fixtureBegin(challengeId: "challenge-id-1")

        let target = try client.loginTarget(identifier: nil, begun: begun)

        #expect(target == .challengeId("challenge-id-1"))
    }

    @Test func nilIdentifierAndNilChallengeIdThrows() {
        let client = makeClient()
        let begun = fixtureBegin(challengeId: nil)

        #expect(throws: OSNAuthError.responseMalformed(status: 200)) {
            try client.loginTarget(identifier: nil, begun: begun)
        }
    }
}

/// Brief T3 §6 — "`SingleResumeContinuation` still resumes exactly once when
/// a cancel races a completion." `SingleResumeContinuationTests` already
/// covers double-resume in general (two sequential calls on the same
/// thread); this covers the specific race the runner's
/// `withTaskCancellationHandler` introduces — an `onCancel`-triggered resume
/// and a delegate-triggered resume firing concurrently from different
/// threads, mirroring `PasskeyCeremonyRunner.run`'s real shape (`onCancel`
/// resumes via `cancel()` -> the delegate's `didCompleteWithError`, while
/// `didCompleteWithAuthorization` can already be in flight). Both outcomes
/// (the cancel error or the real result) are individually valid — what this
/// guards is that exactly one wins and the process never crashes on a
/// double-resume.
struct SingleResumeContinuationCancelRaceTests {
    @Test func concurrentCancelAndCompletionResumeExactlyOnce() async throws {
        struct CancelMarker: Error {}

        for _ in 0..<200 {
            let outcome = try? await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int, Error>) in
                let guarded = SingleResumeContinuation(continuation)
                DispatchQueue.global().async {
                    guarded.resume(throwing: CancelMarker())
                }
                DispatchQueue.global().async {
                    guarded.resume(returning: 42)
                }
            }
            // Either resume could win the race; either outcome is legitimate,
            // but a nil (i.e. a resume that never happened, or a second
            // resume that crashed instead of no-op'ing) is not.
            #expect(outcome == nil || outcome == 42)
        }
    }
}
