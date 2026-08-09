import SwiftUI

/// Which of the two `GlassButton` treatments to render.
public enum GlassButtonKind {
    /// Accent-filled — the one action a screen wants you to take.
    case primary
    /// Plain glass — everything else.
    case secondary
}

/// Primary (accent-filled) or secondary (glass) call to action. Wraps the
/// SDK's own glass button styles (`GlassProminentButtonStyle` / `GlassButtonStyle`,
/// exposed as `.glassProminent` / `.glass`) rather than reimplementing the
/// material by hand.
///
/// Layer: its own glass surface. Don't place it inside a `GlassCard` or other
/// glass container — glass over glass reads as mud. It belongs directly on
/// opaque content, or as a sibling of other glass controls inside a shared
/// `GlassEffectContainer`.
public struct GlassButton: View {
    private let title: String
    private let kind: GlassButtonKind
    private let action: () -> Void

    public init(_ title: String, kind: GlassButtonKind = .primary, action: @escaping () -> Void) {
        self.title = title
        self.kind = kind
        self.action = action
    }

    public var body: some View {
        switch kind {
        case .primary:
            Button(title, action: action)
                .tint(OSNColor.accent)
                .buttonStyle(.glassProminent)
        case .secondary:
            Button(title, action: action)
                .buttonStyle(.glass)
        }
    }
}

#Preview("GlassButton — Light") {
    VStack(spacing: 16) {
        GlassButton("Join event") {}
        GlassButton("Not now", kind: .secondary) {}
    }
    .padding()
    .preferredColorScheme(.light)
}

#Preview("GlassButton — Dark") {
    VStack(spacing: 16) {
        GlassButton("Join event") {}
        GlassButton("Not now", kind: .secondary) {}
    }
    .padding()
    .preferredColorScheme(.dark)
}
