import Foundation
import OSNAPI
import OSNAuth

/// The four things the passkeys screen does, named in its own terms.
///
/// Same seam as `DevicesAPI`, and for a second reason on top of the test
/// double: three of these four calls run a live WebAuthn ceremony first, and
/// the step-up dance is exactly what a view model must not know about. The
/// real conformance below is the only place `StepUpPasskeyClient` appears.
///
/// The mutating calls are `@MainActor` because
/// `ASAuthorizationController` is: the ceremony has to be started from the
/// main actor with a live presentation anchor.
public protocol PasskeysAPI: Sendable {
    func listPasskeys() async throws -> [MusubiPasskey]
    @MainActor func renamePasskey(id: String, label: String) async throws
    /// - Returns: the server's `remaining` count after the delete.
    @MainActor func deletePasskey(id: String) async throws -> Int
    @MainActor func addPasskey() async throws
}

public enum PasskeysAPIError: Error, Equatable, CustomStringConvertible {
    /// `/profiles/list` came back empty. Every account has a profile, so
    /// this means the call was made without a usable session rather than
    /// that the user has none.
    case noProfile

    public var description: String {
        switch self {
        case .noProfile:
            "Couldn't work out which profile to enrol the passkey under."
        }
    }
}

/// `PasskeysAPI` over the `OSNAuth` clients.
///
/// Every mutation mints its own step-up token first. They are single-use and
/// short-lived, so there is nothing to cache: one ceremony per action is the
/// contract, and it is also what makes the action safe.
public struct OSNPasskeysAPI: PasskeysAPI {
    private let management: PasskeyManagementClient
    private let stepUp: StepUpPasskeyClient
    private let enrollment: PasskeyEnrollmentClient
    private let client: any APIProtocol
    private let anchorProvider: PresentationAnchorProvider

    public init(
        management: PasskeyManagementClient,
        stepUp: StepUpPasskeyClient,
        enrollment: PasskeyEnrollmentClient,
        client: any APIProtocol,
        anchorProvider: @escaping PresentationAnchorProvider
    ) {
        self.management = management
        self.stepUp = stepUp
        self.enrollment = enrollment
        self.client = client
        self.anchorProvider = anchorProvider
    }

    public func listPasskeys() async throws -> [MusubiPasskey] {
        try await management.list().map(MusubiPasskey.init)
    }

    /// Rename mints `passkey_delete`, not a `passkey_rename` that doesn't
    /// exist: the server shares one verifier for both
    /// (`osn/api/src/services/auth/step-up.ts:398-400`). Mirroring that is
    /// deliberate — a `passkey_rename` purpose would simply be rejected.
    @MainActor
    public func renamePasskey(id: String, label: String) async throws {
        let token = try await stepUp.mintStepUpToken(purpose: .passkeyDelete, anchorProvider: anchorProvider)
        try await management.rename(id: id, label: label, stepUpToken: token.stepUpToken)
    }

    @MainActor
    public func deletePasskey(id: String) async throws -> Int {
        let token = try await stepUp.mintStepUpToken(purpose: .passkeyDelete, anchorProvider: anchorProvider)
        return try await management.delete(id: id, stepUpToken: token.stepUpToken).remaining
    }

    /// Enrolling from a signed-in account always steps up — the "first
    /// passkey, no ceremony available" case `PasskeyEnrollmentClient`
    /// documents is registration, where there is no account to step up
    /// against yet. Here there is one, by definition: the screen is behind a
    /// sign-in.
    @MainActor
    public func addPasskey() async throws {
        let profileId = try await resolveProfileId()
        let token = try await stepUp.mintStepUpToken(purpose: .passkeyRegister, anchorProvider: anchorProvider)
        _ = try await enrollment.register(
            profileId: profileId,
            stepUpToken: token.stepUpToken,
            anchorProvider: anchorProvider
        )
    }

    /// A restored session is `signedIn(nil)` — `PasskeyProfile` only ever
    /// arrives from a live `/login/passkey/complete`, so the profile id has
    /// to come off the wire. First profile: passkeys are held by the
    /// account, and the id only names the WebAuthn user the ceremony is run
    /// as.
    private func resolveProfileId() async throws -> String {
        let profiles = try await client.listAccountProfiles(.init()).ok.body.json.profiles
        guard let first = profiles.first else {
            throw PasskeysAPIError.noProfile
        }
        return first.id
    }
}
