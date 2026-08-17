import OSNAuth
import OSNAuthUI
import SwiftUI

/// App shell root: gates on `OSNSession.state` directly — Musubi has no
/// feature-specific session wrapper, nothing to add on top of sign-in.
/// Construct once per app launch and pass the iOS anchor provider in from
/// `App.swift` (this package can't import UIKit).
public struct MusubiRootView: View {
    private let session: OSNSession
    private let anchorProvider: PresentationAnchorProvider

    public init(session: OSNSession, anchorProvider: @escaping PresentationAnchorProvider) {
        self.session = session
        self.anchorProvider = anchorProvider
    }

    public var body: some View {
        content
            .task {
                if shouldRestore(session.state) {
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
            PasskeySignInView(appName: "Musubi", session: session, anchorProvider: anchorProvider)
        case .signedIn:
            MusubiAccountView(session: session)
        }
    }
}

/// The gate `MusubiRootView`'s `.task` runs on: restore only fires while the
/// session is still in its initial `.restoring` state, so it runs at most
/// once per launch and a signed-in/signed-out/failed session is never
/// re-restored. Pulled out of the view body so it's reachable from a test —
/// `swift test` can't render SwiftUI, and a test that reimplements this
/// switch against its own copy would stay green after the real gate broke.
func shouldRestore(_ state: OSNSession.SessionState) -> Bool {
    state == .restoring
}
