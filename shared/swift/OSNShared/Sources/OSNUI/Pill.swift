import SwiftUI

/// Small mono-type label for categories, status tags and eyebrow text. Takes
/// a string and a tint — no domain knowledge of what the label means.
///
/// Layer: a flat, non-glass fill. Safe on top of any surface, including a
/// `GlassCard`, since it never introduces its own glass material.
public struct Pill: View {
    private let text: String
    private let tint: Color

    public init(_ text: String, tint: Color) {
        self.text = text
        self.tint = tint
    }

    public var body: some View {
        Text(text.uppercased())
            .font(.osn(.mono, size: 11, relativeTo: .caption2))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(tint.opacity(0.15), in: Capsule())
    }
}

#Preview("Pill — Light") {
    HStack {
        Pill("Live", tint: OSNColor.badgeLive)
        Pill("Music", tint: OSNColor.accent)
    }
    .padding()
    .preferredColorScheme(.light)
}

#Preview("Pill — Dark") {
    HStack {
        Pill("Live", tint: OSNColor.badgeLive)
        Pill("Music", tint: OSNColor.accent)
    }
    .padding()
    .preferredColorScheme(.dark)
}
