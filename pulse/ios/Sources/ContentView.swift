import OSNKit
import SwiftUI

/// A0 placeholder: proves the app target links OSNKit rather than just
/// compiling against it. Later tasks replace this with real UI.
struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text("Pulse")
                .font(.largeTitle.bold())
            Text(Environment.local.baseURL.absoluteString)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
