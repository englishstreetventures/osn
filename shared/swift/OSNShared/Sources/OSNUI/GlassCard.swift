import SwiftUI

/// The container an event card (or any other content) sits in. Content-agnostic:
/// takes a `@ViewBuilder`, not a domain model — `OSNUI` must not know what an
/// event is.
///
/// Layer: base glass surface. Sits over opaque content behind it, never over
/// another glass surface. Placing several `GlassCard`s side by side (a feed, a
/// grid)? Wrap the group in a `GlassEffectContainer` so they blend and morph as
/// one instead of each rendering its own separately-lit slab.
public struct GlassCard<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
            .padding()
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

#Preview("GlassCard — Light") {
    GlassCard {
        VStack(alignment: .leading, spacing: 4) {
            Text("Rooftop Sundown")
                .font(.headline)
            Text("Saturday, 6:00 PM")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }
    .padding()
    .preferredColorScheme(.light)
}

#Preview("GlassCard — Dark") {
    GlassCard {
        VStack(alignment: .leading, spacing: 4) {
            Text("Rooftop Sundown")
                .font(.headline)
            Text("Saturday, 6:00 PM")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }
    .padding()
    .preferredColorScheme(.dark)
}
