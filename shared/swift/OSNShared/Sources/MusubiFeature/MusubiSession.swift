import Foundation
import Observation
import OSNAPI
import OSNAuth
import OSNKit

/// Owns Musubi auth state for the whole app shell, and is the second
/// consumer of the shared cookie jar: Pulse and Musubi both build their
/// `URLSession` from `SharedCookieJar.makeSession()`, so a sign-in in
/// either app is a sign-in in both — the session cookie lives in the
/// `group.social.musubi.session` App Group container, not in one app's
/// sandbox.
///
/// Structurally this mirrors `PulseSession`, with one difference that
/// matters: Musubi talks to osn-api itself, so the identity host and the
/// API host are the same `Environment` and there is only ever one
/// `TokenRefresher` here.
@MainActor
@Observable
public final class MusubiSession {
    /// Same shape as `PulseSession.SessionState`, and optional for the same
    /// reason: a silent restore only round-trips `TokenRefresher.refresh()`,
    /// which returns a `TokenGrant`, never a `PasskeyProfile`.
    public enum SessionState: Equatable {
        case restoring
        case signedOut
        case signedIn(PasskeyProfile?)
        case failed(String)
    }

    public private(set) var state: SessionState = .restoring

    /// The profile the app is signed in as, when it knows — which is after a
    /// sign-in, and after a profile switch it made itself.
    ///
    /// `nil` after a silent restore: the restore round-trips a token, and no
    /// route on osn-api answers "which profile is this token". Kept beside
    /// `state` rather than inside it because `state`'s payload is what the
    /// login response said, and a switch doesn't produce one of those.
    public private(set) var currentProfileID: String?

    /// Every osn-api call in this feature goes through this client. The
    /// bearer middleware inside it consults `OSNAuthenticatedOperations`,
    /// so the sign-in and `/token` calls go out with no `Authorization`
    /// header while `listSessions` and friends get one.
    public let api: any APIProtocol

    private let tokenRefresher: TokenRefresher
    private let loginClient: PasskeyLoginClient
    private let passkeyManagementClient: PasskeyManagementClient
    private let stepUpClient: StepUpPasskeyClient
    private let passkeyEnrollmentClient: PasskeyEnrollmentClient
    private let accountExportClient: AccountExportClient

    /// - Parameter environment: identity host for passkey ceremonies, token
    ///   refresh *and* the API. Defaults to `.local`; the app target picks
    ///   `.production` (`id.musubi.social`) when it ships.
    /// - Throws: whatever `SharedCookieJar.makeSession()` throws
    ///   (`OSNKitError.appGroupContainerUnavailable` while the App Group
    ///   entitlement is still unregistered — see `osn/ios/project.yml`'s
    ///   `BLOCKED:` comment). No working `URLSession` means no session at
    ///   all, so it isn't folded into `SessionState`.
    public init(environment: Environment = .local) throws {
        let session = try SharedCookieJar.makeSession()
        let tokenRefresher = TokenRefresher(session: session, environment: environment)
        self.tokenRefresher = tokenRefresher
        self.loginClient = PasskeyLoginClient(session: session, environment: environment)
        self.passkeyManagementClient = PasskeyManagementClient(session: session, environment: environment)
        self.stepUpClient = StepUpPasskeyClient(session: session, environment: environment)
        self.passkeyEnrollmentClient = PasskeyEnrollmentClient(session: session, environment: environment)
        self.accountExportClient = AccountExportClient(session: session, environment: environment)
        self.api = makeOSNClient(environment: environment, session: session, tokenRefresher: tokenRefresher)
    }

    /// The passkeys screen's API, assembled from the three `OSNAuth` clients
    /// this session already owns. Built here rather than in the view because
    /// the clients are built off the shared-jar `URLSession`, which nothing
    /// outside this type holds.
    ///
    /// - Parameter anchorProvider: the app target's key-window lookup —
    ///   every call on the returned API runs a passkey ceremony that needs
    ///   somewhere to present.
    public func makePasskeysAPI(anchorProvider: @escaping PresentationAnchorProvider) -> OSNPasskeysAPI {
        OSNPasskeysAPI(
            management: passkeyManagementClient,
            stepUp: stepUpClient,
            enrollment: passkeyEnrollmentClient,
            client: api,
            anchorProvider: anchorProvider
        )
    }

    /// The security screen's API. Only two of its five calls are `OSNAuth`
    /// work — the ack routes and the generate route each need a step-up
    /// token first — so it takes the same step-up client the passkeys screen
    /// uses, plus the generated osn-api client for the routes themselves.
    ///
    /// - Parameter anchorProvider: the app target's key-window lookup, for
    ///   the ceremonies the writes run.
    public func makeSecurityAPI(anchorProvider: @escaping PresentationAnchorProvider) -> OSNSecurityAPI {
        OSNSecurityAPI(
            client: api,
            stepUp: stepUpClient,
            anchorProvider: anchorProvider
        )
    }

    /// The account screen's API. Nine calls, four of which run a ceremony,
    /// and one of which — the export — can't go through the generated client
    /// at all (`AccountExportClient` says why).
    ///
    /// - Parameter anchorProvider: the app target's key-window lookup, for
    ///   the ceremonies behind the email change, the export and the delete.
    public func makeAccountAPI(anchorProvider: @escaping PresentationAnchorProvider) -> OSNAccountAPI {
        OSNAccountAPI(
            client: api,
            stepUp: stepUpClient,
            export: accountExportClient,
            anchorProvider: anchorProvider
        )
    }

    /// Told by the account screen after a switch. The access token has
    /// already been swapped by then — this only keeps the shell's idea of
    /// who's signed in from going stale.
    public func adopt(profile: MusubiProfile) {
        currentProfileID = profile.id
    }

    /// Silent restore on launch. A throw from `TokenRefresher.refresh()`
    /// means "signed out", not an error banner.
    public func restore() async {
        state = .restoring
        do {
            try await tokenRefresher.refresh()
            state = .signedIn(nil)
        } catch {
            state = .signedOut
        }
    }

    public func signIn(
        identifier: String?,
        anchorProvider: @escaping PresentationAnchorProvider
    ) async throws {
        let response = try await loginClient.signIn(identifier: identifier, anchorProvider: anchorProvider)
        currentProfileID = response.profile.id
        state = .signedIn(response.profile)
    }

    /// Also the landing point for "I just revoked the session I'm sitting
    /// on" — `revokeSession` on the current session leaves the app holding
    /// an access token the server will stop honouring, so the devices
    /// screen calls this rather than pretending the row simply vanished.
    public func signOut() async {
        try? await tokenRefresher.logout()
        try? KeychainAccessTokenStore.delete()
        currentProfileID = nil
        state = .signedOut
    }
}
