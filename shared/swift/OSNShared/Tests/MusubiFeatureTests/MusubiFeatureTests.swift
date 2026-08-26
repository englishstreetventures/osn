import Foundation
import OSNKit
import OSNTesting
import Testing
@testable import MusubiFeature
@testable import OSNAuth

@MainActor
private func makeOSNSession(environment: Environment, session: URLSession, tokenRefresher: TokenRefresher) -> OSNSession {
    OSNSession(
        environment: environment,
        urlSession: session,
        tokenRefresher: tokenRefresher,
        loginClient: PasskeyLoginClient(session: session, environment: environment)
    )
}

/// T-U2: `MusubiRootView` gates `session.restore()` on `shouldRestore(_:)`.
/// No Keychain/network access, so no serialising trait needed.
@Suite
struct ShouldRestoreTests {
    @Test func restoringIsTrue() {
        #expect(shouldRestore(.restoring))
    }

    @Test func signedOutIsFalse() {
        #expect(!shouldRestore(.signedOut))
    }

    @Test func signedInWithNoProfileIsFalse() {
        #expect(!shouldRestore(.signedIn(nil)))
    }

    @Test func signedInWithProfileIsFalse() {
        let profile = PasskeyProfile(
            id: "user-1",
            handle: "aniket",
            email: "aniket@example.com",
            displayName: "Aniket",
            avatarUrl: nil
        )
        #expect(!shouldRestore(.signedIn(profile)))
    }

    @Test func failedIsFalse() {
        #expect(!shouldRestore(.failed("session expired")))
    }
}

/// T-U1: `fetchPasskeys(session:)` — the network half of
/// `MusubiAccountView.loadPasskeys()`. Touches the real Keychain via
/// `ensureFreshAccessToken()`/`TokenRefresher`, so it shares the
/// cross-target serialized lock with every other Keychain-touching suite
/// (`OSNSessionTests.swift:29`).
@Suite(.serialized, .keychainSerializing)
@MainActor
struct FetchPasskeysTests {
    @Test func successReturnsSummariesAndLeavesStateUnchanged() async throws {
        try KeychainAccessTokenStore.delete()
        let environment = Environment.local
        let session = makeMockSession()
        let tokenRefresher = TokenRefresher(session: session, environment: environment)

        MockURLProtocol.handler = { _ in
            let body = """
            {"access_token":"at-fresh-1","token_type":"Bearer","expires_in":300,"scope":"openid profile"}
            """
            return (
                200,
                ["Content-Type": "application/json", "Set-Cookie": "osn_session=rotated-1; Path=/"],
                Data(body.utf8)
            )
        }

        let osnSession = makeOSNSession(environment: environment, session: session, tokenRefresher: tokenRefresher)
        await osnSession.restore()
        #expect(osnSession.state == .signedIn(nil))

        MockURLProtocol.handler = { _ in
            let body = """
            {"passkeys":[{"id":"pk-1","label":"iPhone","aaguid":null,"transports":null,"backupEligible":null,"backupState":null,"createdAt":1,"lastUsedAt":null}]}
            """
            return (200, ["Content-Type": "application/json"], Data(body.utf8))
        }

        let stateBefore = osnSession.state
        let passkeys = try await fetchPasskeys(session: osnSession)

        #expect(passkeys.map(\.id) == ["pk-1"])
        #expect(osnSession.state == stateBefore)
        #expect(osnSession.state == .signedIn(nil))

        try KeychainAccessTokenStore.delete()
    }

    @Test func listFailureThrowsAndLeavesStateUnchanged() async throws {
        try KeychainAccessTokenStore.delete()
        let environment = Environment.local
        let session = makeMockSession()
        let tokenRefresher = TokenRefresher(session: session, environment: environment)

        MockURLProtocol.handler = { _ in
            let body = """
            {"access_token":"at-fresh-2","token_type":"Bearer","expires_in":300,"scope":"openid profile"}
            """
            return (
                200,
                ["Content-Type": "application/json", "Set-Cookie": "osn_session=rotated-2; Path=/"],
                Data(body.utf8)
            )
        }

        let osnSession = makeOSNSession(environment: environment, session: session, tokenRefresher: tokenRefresher)
        await osnSession.restore()
        #expect(osnSession.state == .signedIn(nil))

        MockURLProtocol.handler = { _ in
            let body = #"{"error":"server_error","message":"boom"}"#
            return (500, ["Content-Type": "application/json"], Data(body.utf8))
        }

        let stateBefore = osnSession.state
        await #expect(throws: (any Error).self) {
            try await fetchPasskeys(session: osnSession)
        }
        #expect(osnSession.state == stateBefore)
        #expect(osnSession.state == .signedIn(nil))

        try KeychainAccessTokenStore.delete()
    }
}
