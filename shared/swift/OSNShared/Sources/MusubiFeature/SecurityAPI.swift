import Foundation
import OSNAPI
import OSNAuth

/// The five calls the security screen makes, named in its own terms.
///
/// Same seam as `DevicesAPI` and `PasskeysAPI`: `APIProtocol` has 73
/// methods, and three of these five run a passkey ceremony first, which is
/// the part a view model must not know about. `OSNSecurityAPI` below is the
/// only place `StepUpPasskeyClient` appears.
///
/// Reads are plain; writes are `@MainActor` because
/// `ASAuthorizationController` is.
public protocol SecurityAPI: Sendable {
    func listSecurityEvents() async throws -> [MusubiSecurityEvent]
    func recoveryStatus() async throws -> MusubiRecoveryStatus
    /// - Returns: the server's `acknowledged` — `false` when the id matched
    ///   nothing unacknowledged. Not an error: both "already acked" and
    ///   "never existed" answer the same way, and both are idempotent.
    @MainActor func acknowledgeEvent(id: String) async throws -> Bool
    /// - Returns: how many events the call acknowledged.
    @MainActor func acknowledgeAllEvents() async throws -> Int
    /// - Returns: the new codes, in plaintext, **once**. The server keeps
    ///   only hashes, so nothing can show them again.
    @MainActor func generateRecoveryCodes() async throws -> [String]
}

/// `SecurityAPI` over the generated osn-api client plus `OSNAuth`'s step-up
/// client.
///
/// No bespoke `OSNAuth` client is needed here: every one of these routes
/// takes an access token and, where gated, a step-up token in the JSON body
/// — both of which the generated client and `StepUpPasskeyClient` already
/// supply between them.
public struct OSNSecurityAPI: SecurityAPI {
    private let client: any APIProtocol
    private let stepUp: StepUpPasskeyClient
    private let anchorProvider: PresentationAnchorProvider

    public init(
        client: any APIProtocol,
        stepUp: StepUpPasskeyClient,
        anchorProvider: @escaping PresentationAnchorProvider
    ) {
        self.client = client
        self.stepUp = stepUp
        self.anchorProvider = anchorProvider
    }

    public func listSecurityEvents() async throws -> [MusubiSecurityEvent] {
        try await client.listSecurityEvents(.init()).ok.body.json.events.map(MusubiSecurityEvent.init)
    }

    public func recoveryStatus() async throws -> MusubiRecoveryStatus {
        try await MusubiRecoveryStatus(client.getRecoveryStatus(.init()).ok.body.json)
    }

    /// Acknowledging is step-up gated on purpose: an XSS-captured access
    /// token must not be able to silently dismiss the banner that exists
    /// precisely to notice that compromise.
    @MainActor
    public func acknowledgeEvent(id: String) async throws -> Bool {
        let token = try await mintAckToken()
        return try await client.acknowledgeSecurityEvent(
            .init(path: .init(id: id), body: .json(.init(stepUpToken: token)))
        ).ok.body.json.acknowledged
    }

    /// One ceremony for the lot. The alternative — a prompt per row — would
    /// train the user to tap through Face ID without reading, which is the
    /// habit this screen is trying not to build.
    @MainActor
    public func acknowledgeAllEvents() async throws -> Int {
        let token = try await mintAckToken()
        let acknowledged = try await client.acknowledgeAllSecurityEvents(
            .init(body: .json(.init(stepUpToken: token)))
        ).ok.body.json.acknowledged
        return Int(acknowledged)
    }

    @MainActor
    public func generateRecoveryCodes() async throws -> [String] {
        let token = try await stepUp.mintStepUpToken(purpose: .recoveryGenerate, anchorProvider: anchorProvider)
        return try await client.generateRecoveryCodes(
            .init(body: .json(.init(stepUpToken: token.stepUpToken)))
        ).ok.body.json.recoveryCodes
    }

    @MainActor
    private func mintAckToken() async throws -> String {
        try await stepUp.mintStepUpToken(purpose: .securityEventAck, anchorProvider: anchorProvider).stepUpToken
    }
}
