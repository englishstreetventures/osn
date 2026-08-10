import SwiftUI

/// Type roles named in `pulse/DESIGN.md`. Each resolves to its named family
/// via `Font.custom(_:size:relativeTo:)`, which scales with Dynamic Type and
/// (per Apple platform behavior) substitutes the system font at the same
/// point size when the named family isn't installed — so these roles work
/// today and sharpen once font files are vendored. Web's fixed px sizes in
/// `DESIGN.md` are a starting ratio, not copied literally: `size` is left to
/// call sites, which should pick a `TextStyle`-relative value.
///
/// BLOCKED: font files not vendored. Instrument Serif and Geist/Geist Mono
/// are OFL 1.1 (pulled from Google Fonts in the web app at
/// `pulse/web/src/entry-server.tsx`); vendoring the `.ttf`/`.otf` files into this
/// package and registering them (Info.plist `UIAppFonts` / `CTFontManager`)
/// is a decision for the app target, not made here. Until then `Font.custom`
/// falls back to the system font.
public enum OSNTypeRole {
    /// Hero headlines, section headers. Family: Instrument Serif.
    case display
    /// Navigation, card body, labels, buttons. Family: Geist.
    case body
    /// Timestamps, eyebrow text, category tags. Family: Geist Mono.
    case mono
}

extension Font {
    /// Resolves an `OSNTypeRole` to its named family at `size`, scaling with
    /// Dynamic Type relative to `textStyle`.
    public static func osn(_ role: OSNTypeRole, size: CGFloat, relativeTo textStyle: Font.TextStyle = .body) -> Font {
        switch role {
        case .display:
            return .custom("Instrument Serif", size: size, relativeTo: textStyle)
        case .body:
            return .custom("Geist", size: size, relativeTo: textStyle)
        case .mono:
            return .custom("Geist Mono", size: size, relativeTo: textStyle)
        }
    }
}
