import SwiftUI

/// The pulsing `badgeLive` dot marking something happening now.
///
/// Layer: a flat, non-glass indicator. Safe on top of any surface, including
/// a `GlassCard`.
///
/// Respects Reduce Motion: when `accessibilityReduceMotion` is on, the dot is
/// static rather than slowed — an animation that never stops is a genuine
/// accessibility problem for vestibular and attention disorders, not a
/// preference to merely tone down.
public struct LiveBadge: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isPulsing = false

    public init() {}

    public var body: some View {
        Circle()
            .fill(OSNColor.badgeLive)
            .frame(width: 8, height: 8)
            .scaleEffect(reduceMotion ? 1 : (isPulsing ? 1.4 : 1))
            .opacity(reduceMotion ? 1 : (isPulsing ? 0.4 : 1))
            .animation(
                reduceMotion ? nil : .easeInOut(duration: 0.9).repeatForever(autoreverses: true),
                value: isPulsing
            )
            .onAppear {
                guard !reduceMotion else { return }
                isPulsing = true
            }
            .accessibilityLabel("Live")
    }
}

#Preview("LiveBadge — Light") {
    LiveBadge()
        .padding()
        .preferredColorScheme(.light)
}

#Preview("LiveBadge — Dark") {
    LiveBadge()
        .padding()
        .preferredColorScheme(.dark)
}
