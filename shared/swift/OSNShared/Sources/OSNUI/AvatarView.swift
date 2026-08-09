import SwiftUI

/// Circular avatar frame with an optional `closeFriend` ring. The ring is a
/// state the view resolves for itself (`isCloseFriend`), not a color the
/// caller passes in — `OSNUI` must not know what "close friend" means beyond
/// that one token.
///
/// Layer: a flat, non-glass frame. Safe on top of any surface, including a
/// `GlassCard`.
public struct AvatarView<Content: View>: View {
    private let isCloseFriend: Bool
    private let content: Content

    public init(isCloseFriend: Bool = false, @ViewBuilder content: () -> Content) {
        self.isCloseFriend = isCloseFriend
        self.content = content()
    }

    public var body: some View {
        content
            .clipShape(Circle())
            .overlay {
                if isCloseFriend {
                    Circle()
                        .strokeBorder(OSNColor.closeFriend, lineWidth: 2)
                }
            }
    }
}

#Preview("AvatarView — Light") {
    HStack(spacing: 16) {
        AvatarView {
            Circle().fill(.gray.opacity(0.3))
        }
        .frame(width: 48, height: 48)

        AvatarView(isCloseFriend: true) {
            Circle().fill(.gray.opacity(0.3))
        }
        .frame(width: 48, height: 48)
    }
    .padding()
    .preferredColorScheme(.light)
}

#Preview("AvatarView — Dark") {
    HStack(spacing: 16) {
        AvatarView {
            Circle().fill(.gray.opacity(0.3))
        }
        .frame(width: 48, height: 48)

        AvatarView(isCloseFriend: true) {
            Circle().fill(.gray.opacity(0.3))
        }
        .frame(width: 48, height: 48)
    }
    .padding()
    .preferredColorScheme(.dark)
}
