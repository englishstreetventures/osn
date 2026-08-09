# A4 notes — OSNUI

Verified/not-verified/BLOCKED per brief section. "It compiles" is not evidence of correctness — flagged where that's all I have.

## Glass API — grepped from real SDK, not inferred

```
SDK=$(xcrun --sdk macosx --show-sdk-path)
grep -rn "public struct Glass \|glassEffect(_:in:\|struct GlassEffectContainer\|glassEffectID(_:in:\|glassEffectUnion(id:namespace:\|struct GlassEffectTransition\|struct DefaultGlassEffectShape" \
  "$SDK/System/Library/Frameworks/SwiftUICore.framework/Modules/SwiftUICore.swiftmodule/"*.swiftinterface
```

Found in `SwiftUICore` (macOS 26.5 SDK, `arm64e-apple-macos.swiftinterface`):

- `public struct Glass : Swift.Equatable, Swift.Sendable` (line 5753)
- `public struct GlassEffectContainer<Content> : SwiftUICore.View` (line 9045)
- `public struct GlassEffectTransition : Swift.Sendable` (line 2847)
- `public struct DefaultGlassEffectShape : SwiftUICore.Shape` (line 2534)
- `func glassEffect(_ glass: Glass = .regular, in shape: some Shape = DefaultGlassEffectShape()) -> some View` (line 2529)
- `func glassEffectTransition(_ transition: GlassEffectTransition) -> some View` (line 2861)
- `func glassEffectUnion(id: (some (Hashable & Sendable))?, namespace: Namespace.ID) -> some View` (line 9880)
- `func glassEffectID(_ id: (some (Hashable & Sendable))?, in namespace: Namespace.ID) -> some View` (line 17372)

Found in `SwiftUI` module (button styles):

- `extension PrimitiveButtonStyle where Self == GlassButtonStyle { static var glass: GlassButtonStyle }`
- `public struct GlassButtonStyle : PrimitiveButtonStyle`
- `extension PrimitiveButtonStyle where Self == GlassProminentButtonStyle { static var glassProminent: GlassProminentButtonStyle }`
- `public struct GlassProminentButtonStyle : PrimitiveButtonStyle`

Used: `.glassEffect(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))` in `GlassCard`, `.buttonStyle(.glass)` / `.buttonStyle(.glassProminent)` in `GlassButton`. `GlassEffectContainer` exists and is documented (doc comments on `GlassCard`/`GlassButton` tell callers to group siblings in one) but is **not used** anywhere in this package — no screen assembles multiple glass siblings yet, that's A5's job.

## Token conversion — oklch → Display P3

Method: oklch → OKLab → linear sRGB (Björn Ottosson's published matrices) → CIE XYZ (D65) → linear Display P3 → gamma-encode (sRGB OETF, which Display P3 shares). Computed with a standalone Python script (not committed — one-off arithmetic, not project code), values transcribed into `Colors.swift`.

| Token | oklch source | Display P3 (R, G, B) | Note |
|---|---|---|---|
| `accent` | `oklch(0.68 0.18 38)` | `0.8806, 0.4389, 0.2824` | |
| `accentStrong` | `oklch(0.58 0.19 35)` | `0.7620, 0.2939, 0.1632` | |
| `accentSoft` | `oklch(0.95 0.05 45)` | `1.0000, 0.9031, 0.8386` | out of P3 gamut on red — linear 1.0650, encoded 1.0280 — R alone clamped to 1.0 |
| `closeFriend` | `oklch(0.66 0.16 145)` | `0.3861, 0.6612, 0.3523` | |
| `badgeLive` | `oklch(0.72 0.17 22)` | `0.9253, 0.4804, 0.4675` | |
| `accentForeground` (light) | `oklch(0.99 0.004 80)` | `0.9916, 0.9863, 0.9765` | |
| `accentForeground` (dark) | `oklch(0.17 0.008 60)` | `0.0687, 0.0579, 0.0482` | |

`accentForeground` is a single `Color` resolved from a dynamic-provider platform color (`UIColor(dynamicProvider:)` on iOS via `#if canImport(UIKit)`, `NSColor(name:dynamicProvider:)` on macOS via `#elseif canImport(AppKit)`) — no call-site branching, matches by trait/appearance at draw time.

**Guessed / not SDK-confirmed this session:** the UIKit half (`UIColor(dynamicProvider:)`, `Color(uiColor:)`) rests on iOS platform knowledge, not a grep — this machine has no iOS SDK to check against. Only the AppKit/macOS half was exercised by `swift build`/`swift test` (host is macOS). If the iOS API name or behavior is wrong, `OSNUI` still won't compile on this host to catch it — an app-target/iOS build is the only thing that would.

Neutral ramp: not ported, per brief — call sites use system semantic colors (`.primary`, `.secondary`, etc.) for text/fills, e.g. `GlassCard`'s preview content.

## Typography

`Font.osn(_:size:relativeTo:)` resolves `.display`/`.body`/`.mono` to `Font.custom("Instrument Serif"/"Geist"/"Geist Mono", size:relativeTo:)`. `Font.custom(_:size:relativeTo:)` is Dynamic Type-scaling by construction (relative to a `TextStyle`) — that part is SDK-documented API, confirmed by successful compilation and matches the documented signature.

**Guessed / not empirically tested:** that `Font.custom` silently substitutes the system font at the same point size when the named family isn't installed, rather than rendering nothing or asserting. This is standard platform behavior from general iOS/macOS knowledge, not something I ran and observed in this environment (no visual rendering harness here), and not grepped from any doc comment in the swiftinterface (the interface only gives the signature, not the fallback behavior).

**BLOCKED: font files not vendored.** Instrument Serif, Geist, Geist Mono are OFL 1.1, pulled from Google Fonts in the web app (`pulse/app/index.html:9`). To close: obtain the `.ttf`/`.otf` files, vendor them into this package or the app target, and register them (`UIAppFonts` in Info.plist for iOS / `CTFontManagerRegisterFontsForURL` or an Xcode font-registration mechanism for macOS). Not decided here per brief — deferred to whoever owns the app target.

## Components

All five (`GlassCard`, `GlassButton`, `Pill`, `LiveBadge`, `AvatarView`) have a doc comment stating purpose + glass/non-glass layer, both-color-scheme `#Preview`s, and take no domain model — confirmed by reading each file, not just by the build.

`GlassButton` wraps `.glass`/`.glassProminent` rather than reimplementing the material — confirmed by SDK grep before writing (see above), not guessed.

## DoD item 6 — Reduce Motion testability

**Not testable, and no test was added.** `LiveBadge` reads `@Environment(\.accessibilityReduceMotion)`, which SwiftUI resolves from the live system accessibility setting when a view is part of a rendered hierarchy. A Swift Testing `@Test` function has no view host and no way to construct or inject an `EnvironmentValues` into a `View`'s `body` without actually mounting it (e.g. via a snapshot/host harness) — this package has no such dependency, and the brief prohibits inventing one. I did not find, and did not add, a way to instantiate `LiveBadge` and assert its rendered `scaleEffect`/`opacity`/`animation` under a forced `accessibilityReduceMotion = true` using only Swift Testing + SwiftUI. Saying "test if it's readable, and if not, say so" — this is the "say so": DoD item 6 is unverified by test. The logic itself (`reduceMotion ? 1 : ...`, `animation(reduceMotion ? nil : ...)`) is inspectable by reading `LiveBadge.swift` but that is not the same as a passing test.

No `OSNUITests` target was added, since there is nothing else in `OSNUI` that has meaningful unit-testable logic beyond this one untestable case — `Colors.swift`'s values are checked by reading the conversion table above, not by a runtime assertion the brief asked for.

## Independent re-check (orchestrator, on review)

- `swift build` + `swift test` re-run on the macOS host after the review edits
  below: 32 tests, 7 suites, 0 failures.
- All seven conversions re-derived from scratch with an independent
  implementation of the same pipeline (oklch → OKLab → linear sRGB → XYZ D65 →
  linear P3 → sRGB OETF). Every channel matches the committed values to
  ±0.0001. The one correction is the gamut note on `accentSoft`: 1.0651 is the
  *linear* out-of-range figure, 1.0280 the encoded one — both now recorded, so
  the clamp is checkable at either stage.
- `GlassButton`'s doc comment sat on `GlassButtonKind`, so the component itself
  had none — DoD 5 wasn't actually met for it. Moved onto the struct, with a
  separate comment on the enum.
- `Package.swift` confirmed: `.target(name: "OSNUI")`, no `dependencies:`. The
  only imports across the seven files are `SwiftUI` plus `UIKit`/`AppKit` under
  `canImport` in `Colors.swift`.

## Leaf-package check

`Package.swift`: `.target(name: "OSNUI")` — no `dependencies:` argument, so zero dependencies. None of the seven files added under `Sources/OSNUI/` import `OSNKit`, `OSNAuth`, or `PulseAPI`; only `SwiftUI` and, conditionally, `UIKit`/`AppKit`. Confirmed by reading `Package.swift` and every new file's import list, not inferred.
