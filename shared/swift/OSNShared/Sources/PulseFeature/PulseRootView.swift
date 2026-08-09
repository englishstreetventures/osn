import OSNAuth
import OSNUI
import SwiftUI

/// App shell root: gates on `PulseSession.state` and, once signed in, hosts
/// tab navigation (Explore + whatever else is genuinely built). Construct
/// once per app launch and pass the iOS anchor provider in from `App.swift`
/// (this package can't import UIKit).
public struct PulseRootView: View {
    private let session: PulseSession
    private let anchorProvider: PresentationAnchorProvider

    public init(session: PulseSession, anchorProvider: @escaping PresentationAnchorProvider) {
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
            SignInView(session: session, anchorProvider: anchorProvider)
        case .signedIn:
            PulseTabView(session: session)
        }
    }
}

/// Post-sign-in tab navigation. Calendar/Settings/Close Friends are out of
/// scope for this brief — if a slot exists it's an honest empty
/// placeholder, never stubbed data.
struct PulseTabView: View {
    let session: PulseSession

    var body: some View {
        TabView {
            NavigationStack {
                ExploreView(session: session)
            }
            .tabItem { Label("Explore", systemImage: "sparkles") }
        }
    }
}
