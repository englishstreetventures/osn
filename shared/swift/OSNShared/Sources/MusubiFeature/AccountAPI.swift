import Foundation
import OSNAPI
import OSNAuth
import OSNKit

/// The nine calls the account screen makes, named in its own terms.
///
/// Same seam as `DevicesAPI`, `PasskeysAPI` and `SecurityAPI`: the view
/// model never sees `APIProtocol`'s 73 methods, never sees a generated
/// request shape, and never mints a step-up token. Four of these nine run a
/// passkey ceremony inside `OSNAccountAPI` and are `@MainActor` for it,
/// because `ASAuthorizationController` is.
public protocol AccountAPI: Sendable {
    /// Every profile on the signed-in account. The server says nothing
    /// about which is current or which is default — see `MusubiProfile`.
    func listProfiles() async throws -> [MusubiProfile]
    func deletionStatus() async throws -> MusubiDeletionStatus
    /// Signs the app in as another profile on the same account.
    ///
    /// - Returns: the profile now in force. The new access token is stored
    ///   as part of the call, not handed back — see `OSNAccountAPI`.
    func switchProfile(id: String) async throws -> MusubiProfile
    /// Marks a profile the one to land on at next sign-in. Does **not**
    /// switch to it.
    func setDefaultProfile(id: String) async throws -> MusubiProfile
    /// Sends a code to the **new** address. Nothing changes until the code
    /// comes back.
    /// - Returns: the server's `sent`.
    func beginEmailChange(to newEmail: String) async throws -> Bool
    /// - Returns: the address now on the account.
    @MainActor func completeEmailChange(code: String) async throws -> String
    /// - Parameter confirmHandle: must equal the profile's handle verbatim
    ///   or the server answers 400 `handle_mismatch`. It is there to make
    ///   the press deliberate.
    @MainActor func requestDeletion(confirmHandle: String) async throws -> MusubiDeletionSchedule
    /// Cancels a pending deletion inside the grace window.
    ///
    /// No step-up: the session itself is a fresh-enough authenticator for
    /// *un*-deleting, and a user who has lost their passkey mid-window is
    /// exactly who this is for.
    /// - Returns: the server's `cancelled`. `false` is a 200, not an error —
    ///   it means nothing was pending.
    func restore() async throws -> Bool
    /// Runs the export and writes the bundle somewhere the share sheet can
    /// reach it.
    /// - Returns: a file URL the caller owns and is expected to delete.
    @MainActor func exportAccount() async throws -> URL
}

/// `AccountAPI` over the generated osn-api client, `OSNAuth`'s step-up
/// client, and one hand-written client for the export — which the spec
/// cannot describe (see `AccountExportClient`).
public struct OSNAccountAPI: AccountAPI {
    private let client: any APIProtocol
    private let stepUp: StepUpPasskeyClient
    private let export: AccountExportClient
    private let anchorProvider: PresentationAnchorProvider

    public init(
        client: any APIProtocol,
        stepUp: StepUpPasskeyClient,
        export: AccountExportClient,
        anchorProvider: @escaping PresentationAnchorProvider
    ) {
        self.client = client
        self.stepUp = stepUp
        self.export = export
        self.anchorProvider = anchorProvider
    }

    public func listProfiles() async throws -> [MusubiProfile] {
        try await client.listAccountProfiles(.init()).ok.body.json.profiles.map(MusubiProfile.init)
    }

    public func deletionStatus() async throws -> MusubiDeletionStatus {
        try await MusubiDeletionStatus(client.getAccountDeletionStatus(.init()).ok.body.json)
    }

    /// The one call on this screen with a trap in it: a switch re-issues the
    /// **access token**, and every later request that keeps sending the old
    /// one keeps authenticating as the old profile. So the new token is
    /// written to the Keychain here, before the profile is handed back, and
    /// no caller is trusted to remember.
    ///
    /// The session and its cookie are untouched — a switch is a new token on
    /// the same session, which is why there's no `TokenRefresher` work here.
    public func switchProfile(id: String) async throws -> MusubiProfile {
        let grant = try await client.switchProfile(.init(body: .json(.init(profileId: id)))).ok.body.json
        try KeychainAccessTokenStore.save(grant.accessToken, expiresIn: TimeInterval(grant.expiresIn))
        return MusubiProfile(grant.profile)
    }

    public func setDefaultProfile(id: String) async throws -> MusubiProfile {
        try await MusubiProfile(
            client.setDefaultProfile(.init(path: .init(profileId: id))).ok.body.json.profile
        )
    }

    public func beginEmailChange(to newEmail: String) async throws -> Bool {
        try await client.beginEmailChange(.init(body: .json(.init(newEmail: newEmail)))).ok.body.json.sent
    }

    /// Both halves are required together: the code proves the new address,
    /// the step-up proves the person. Neither alone changes anything.
    @MainActor
    public func completeEmailChange(code: String) async throws -> String {
        let token = try await mint(.emailChange)
        return try await client.completeEmailChange(
            .init(body: .json(.init(code: code, stepUpToken: token)))
        ).ok.body.json.email
    }

    /// A 202, not a 200: nothing is erased yet.
    @MainActor
    public func requestDeletion(confirmHandle: String) async throws -> MusubiDeletionSchedule {
        let token = try await mint(.accountDelete)
        return try await MusubiDeletionSchedule(
            client.requestAccountDeletion(
                .init(body: .json(.init(confirmHandle: confirmHandle, stepUpToken: token)))
            ).accepted.body.json
        )
    }

    public func restore() async throws -> Bool {
        try await client.restoreAccount(.init()).ok.body.json.cancelled
    }

    /// Writes the bundle to the caches directory rather than returning it,
    /// because `ShareLink` shares a file and a `Data` in memory is not one.
    ///
    /// Caches and not Documents: this is a copy of data the server already
    /// holds, it is somebody's whole account in plaintext, and the caller
    /// deletes it as soon as the share sheet closes. Caches is the directory
    /// the system will also reap on its own if we somehow don't.
    @MainActor
    public func exportAccount() async throws -> URL {
        let token = try await mint(.accountExport)
        let data = try await export.download(stepUpToken: token)
        let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(AccountExportClient.filename)
        try data.write(to: url, options: .atomic)
        return url
    }

    @MainActor
    private func mint(_ purpose: StepUpPurpose) async throws -> String {
        try await stepUp.mintStepUpToken(purpose: purpose, anchorProvider: anchorProvider).stepUpToken
    }
}
