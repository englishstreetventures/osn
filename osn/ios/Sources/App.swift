import AuthenticationServices
import MusubiFeature
import OSNAuth
import SwiftUI
import UIKit

@main
struct MusubiApp: App {
    @State private var session: OSNSession?
    @State private var sessionError: String?

    var body: some Scene {
        WindowGroup {
            Group {
                if let session {
                    MusubiRootView(session: session, anchorProvider: MusubiApp.keyWindowAnchor)
                } else if let sessionError {
                    Text(sessionError)
                } else {
                    ProgressView()
                }
            }
            .task {
                guard session == nil, sessionError == nil else { return }
                do {
                    session = try OSNSession()
                } catch {
                    sessionError = String(describing: error)
                }
            }
        }
    }

    /// This package can't `import MusubiFeature`'s dependency `OSNAuth`'s
    /// `PresentationAnchorProvider` without also supplying the key
    /// `UIWindow` itself — `MusubiFeature` can't `import UIKit` (must build
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
