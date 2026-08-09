import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Pulse brand tokens, ported from `pulse/app/src/App.css:56-73` (oklch source).
/// Conversion: oklch -> OKLab -> linear sRGB (Ottosson matrices) -> XYZ (D65)
/// -> linear Display P3 -> gamma-encoded (sRGB OETF). Arithmetic and full
/// output in `a4-notes.md`. `.displayP3` used throughout per brief: these are
/// wide-gamut values, not representable in sRGB.
public enum OSNColor {
    /// `--pulse-accent` — oklch(0.68 0.18 38). Coral; brand mark, hero italic, CTAs.
    public static let accent = Color(.displayP3, red: 0.8806, green: 0.4389, blue: 0.2824)

    /// `--pulse-accent-strong` — oklch(0.58 0.19 35). Darker coral; pressed/emphasis states.
    public static let accentStrong = Color(.displayP3, red: 0.7620, green: 0.2939, blue: 0.1632)

    /// `--pulse-accent-soft` — oklch(0.95 0.05 45). Pale coral wash; subtle fills.
    /// Out of Display P3 gamut on red — linear 1.0650, encoded 1.0280 —
    /// so R alone is clamped to 1.0. That shifts the hue very slightly
    /// toward pink rather than desaturating the whole colour, which is the
    /// right trade for a near-white wash.
    public static let accentSoft = Color(.displayP3, red: 1.0000, green: 0.9031, blue: 0.8386)

    /// `--close-friend` — oklch(0.66 0.16 145). Green; close-friend ring state.
    public static let closeFriend = Color(.displayP3, red: 0.3861, green: 0.6612, blue: 0.3523)

    /// `--badge-live` — oklch(0.72 0.17 22). Red-coral; `LiveBadge` dot.
    public static let badgeLive = Color(.displayP3, red: 0.9253, green: 0.4804, blue: 0.4675)

    /// `--pulse-accent-fg` — light `oklch(0.99 0.004 80)` / dark `oklch(0.17 0.008 60)`.
    /// A single scheme-adapting color (no call-site branching): backed by a
    /// dynamic-provider platform color so it resolves per active trait/appearance.
    public static let accentForeground: Color = {
        #if canImport(UIKit)
        return Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(displayP3Red: 0.0687, green: 0.0579, blue: 0.0482, alpha: 1)
                : UIColor(displayP3Red: 0.9916, green: 0.9863, blue: 0.9765, alpha: 1)
        })
        #elseif canImport(AppKit)
        return Color(nsColor: NSColor(name: nil, dynamicProvider: { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return isDark
                ? NSColor(displayP3Red: 0.0687, green: 0.0579, blue: 0.0482, alpha: 1)
                : NSColor(displayP3Red: 0.9916, green: 0.9863, blue: 0.9765, alpha: 1)
        }))
        #endif
    }()
}
