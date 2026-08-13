import OSNAuth
import OSNUI
import SwiftUI

/// App shell root: gates on `MusubiSession.state` and, once signed in,
/// hosts the account surfaces. Construct once per app launch and pass the
/// iOS anchor provider in from `App.swift` (this package can't import
/// UIKit).
///
/// Three signed-in screens now. Sign out sits in each tab's own toolbar
/// rather than a tab of its own: it is an action, not a place.
public struct MusubiRootView: View {
    private let session: MusubiSession
    private let anchorProvider: PresentationAnchorProvider

    public init(session: MusubiSession, anchorProvider: @escaping PresentationAnchorProvider) {
        self.session = session
        self.anchorProvider = anchorProvider
    }

    public var body: some View {
        content
            .task {
                if session.state == .restoring {
                    await session.restore()
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch session.state {
        case .restoring:
            ProgressView()
        case .signedOut, .failed:
            MusubiSignInView(session: session, anchorProvider: anchorProvider)
        case .signedIn:
            TabView {
                Tab("Devices", systemImage: "laptopcomputer.and.iphone") {
                    NavigationStack {
                        DevicesView(session: session)
                            .toolbar { signOutButton }
                    }
                }
                Tab("Passkeys", systemImage: "person.badge.key") {
                    NavigationStack {
                        PasskeysView(session: session, anchorProvider: anchorProvider)
                            .toolbar { signOutButton }
                    }
                }
                Tab("Security", systemImage: "shield") {
                    NavigationStack {
                        SecurityView(session: session, anchorProvider: anchorProvider)
                            .toolbar { signOutButton }
                    }
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var signOutButton: some ToolbarContent {
        ToolbarItem(placement: .secondaryAction) {
            Button("Sign out") {
                Task { await session.signOut() }
            }
        }
    }
}
