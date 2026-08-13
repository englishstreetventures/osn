import OSNAuth
import OSNUI
import SwiftUI

/// App shell root: gates on `MusubiSession.state` and, once signed in,
/// hosts the account surfaces. Construct once per app launch and pass the
/// iOS anchor provider in from `App.swift` (this package can't import
/// UIKit).
///
/// There is one signed-in screen so far, so this is a `NavigationStack`
/// rather than a `TabView` — a tab bar with one tab is a tab bar that lies
/// about what is built. Tabs arrive with the second surface.
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
            NavigationStack {
                DevicesView(session: session)
                    .toolbar {
                        ToolbarItem(placement: .primaryAction) {
                            Button("Sign out") {
                                Task { await session.signOut() }
                            }
                        }
                    }
            }
        }
    }
}
