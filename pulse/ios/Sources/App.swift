import AuthenticationServices
import OSNAuth
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
                    session = try PulseSession()
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
