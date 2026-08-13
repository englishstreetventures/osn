import Foundation
import OSNAPI

/// One profile on the signed-in account, as the account screen shows it.
///
/// An OSN *account* is the thing that holds the passkeys, the email and the
/// sessions; a *profile* is a handle under it, and an account may hold
/// several (`[[wiki/systems/identity-model]]`). Every other screen in this
/// app works on the account; this is the only one that names the profiles.
///
/// The server's `publicProfile` shape carries no "is this the default" and
/// no "is this the one you're signed in as"
/// (`osn/api/src/routes/auth/response-schemas.ts`), so neither is inferred
/// here. What the app knows about the current profile it learned from the
/// sign-in response or from its own switch — see `AccountViewModel`.
public struct MusubiProfile: Identifiable, Equatable, Sendable {
    public let id: String
    public let handle: String
    public let email: String
    public let displayName: String?
    public let avatarUrl: String?

    public init(id: String, handle: String, email: String, displayName: String?, avatarUrl: String?) {
        self.id = id
        self.handle = handle
        self.email = email
        self.displayName = displayName
        self.avatarUrl = avatarUrl
    }

    /// What to put on the row. A profile always has a handle; a display name
    /// is optional and often absent on the profiles nobody has dressed up.
    public var title: String { displayName ?? "@\(handle)" }

    /// The line under it, never a repeat of the line above it.
    public var subtitle: String { displayName == nil ? email : "@\(handle)" }
}

// The same five fields arrive under three different generated types, because
// the spec inlines the profile object at each route rather than naming it
// once under `components`. One init per shape is the price of that; the
// alternative is a `$ref` in `osn/api`, which is a server change and doesn't
// belong in an iOS branch.
extension MusubiProfile {
    public init(_ payload: Operations.ListAccountProfiles.Output.Ok.Body.JsonPayload.ProfilesPayloadPayload) {
        self.init(
            id: payload.id,
            handle: payload.handle,
            email: payload.email,
            displayName: payload.displayName,
            avatarUrl: payload.avatarUrl
        )
    }

    public init(_ payload: Operations.SwitchProfile.Output.Ok.Body.JsonPayload.ProfilePayload) {
        self.init(
            id: payload.id,
            handle: payload.handle,
            email: payload.email,
            displayName: payload.displayName,
            avatarUrl: payload.avatarUrl
        )
    }

    public init(_ payload: Operations.SetDefaultProfile.Output.Ok.Body.JsonPayload.ProfilePayload) {
        self.init(
            id: payload.id,
            handle: payload.handle,
            email: payload.email,
            displayName: payload.displayName,
            avatarUrl: payload.avatarUrl
        )
    }
}
