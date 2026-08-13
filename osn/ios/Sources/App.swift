import AuthenticationServices
import MusubiFeature
import OSNAuth
import SwiftUI
import UIKit

@main
struct MusubiApp: App {
    @State private var session: MusubiSession?
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
                    session = try MusubiSession()
                } catch {
                    sessionError = String(describing: error)
                }
            }
        }
    }

    /// `MusubiFeature` can't `import UIKit` (every target in `OSNShared`
    /// must build on the macOS host), so the key-window lookup behind
    /// `PresentationAnchorProvider` stays in the app target — same split as
    /// `pulse/ios/Sources/App.swift`.
    @MainActor
    private static func keyWindowAnchor() -> ASPresentationAnchor {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first
        let window = scene?.windows.first(where: \.isKeyWindow) ?? scene?.windows.first
        return window ?? ASPresentationAnchor()
    }
}
