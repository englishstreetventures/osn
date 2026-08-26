import AuthenticationServices
import OSNAuth
import OSNKit
import PulseAPI
import PulseFeature
import SwiftUI
import UIKit

@main
struct PulseApp: App {
    @State private var session: PulseSession?
    @State private var sessionError: String?

    var body: some Scene {
        WindowGroup {
            Group {
                if let session {
                    PulseRootView(session: session, anchorProvider: PulseApp.keyWindowAnchor)
                } else if let sessionError {
                    Text(sessionError)
                } else {
                    ProgressView()
                }
            }
            .task {
                guard session == nil, sessionError == nil else { return }
                do {
                    // Both hosts come from this build's configuration, via
                    // `OSNTier` in Info.plist — never a `.local` default, which
                    // would ship a release pointed at localhost. A build that
                    // cannot answer the question throws, and the `sessionError`
                    // branch below says so instead of showing an empty feed.
                    session = try PulseSession(
                        environment: Environment.resolve(),
                        pulseEnvironment: PulseEnvironment.resolve()
                    )
                } catch {
                    sessionError = String(describing: error)
                }
            }
        }
    }

    /// This package can't `import PulseFeature`'s dependency `OSNAuth`'s
    /// `PresentationAnchorProvider` without also supplying the key
    /// `UIWindow` itself — `PulseFeature` can't `import UIKit` (must build
    /// on the macOS host), so this one lookup stays in the app target.
    @MainActor
    private static func keyWindowAnchor() -> ASPresentationAnchor {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first
        let window = scene?.windows.first(where: \.isKeyWindow) ?? scene?.windows.first
        return window ?? ASPresentationAnchor()
    }
}
