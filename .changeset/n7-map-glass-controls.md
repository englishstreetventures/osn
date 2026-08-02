---
"@pulse/app": minor
---

Native glass for the Explore map's floating controls on iOS.

A native subview of `WKWebView` composites above the whole rendered page (one
layer tree), so glass placed above the webview blurs the map but eats any DOM
content in its own rect — there's no z-order or opacity fix for that. So on
iOS, `ExploreMap`'s time scrubber and zoom-control cluster are now built
entirely in UIKit, inside the `contentView` of a `pulse-bridge` native
`UIGlassEffect` (iOS 26+; `UIBlurEffect` below), which composites above the
glass effect and so stays crisp while the effect blurs the map beneath it.
The two panels nest in one `UIGlassContainerEffect` so they merge/morph per
`UIGlassEffect.h`. Native interaction — the +/− zoom buttons and the hour
slider — fires plugin events (`zoomIn`, `zoomOut`, `hourChanged`) that
`ExploreMap.tsx` subscribes to and uses to drive the same map state the DOM
controls would: a new `zoom` signal (1–2.5, 0.25 per tap) scales the map
layer, and the hour drives the existing heatmap.

The DOM scrubber and zoom cluster are unmounted outright on iOS once native
panels are live — not hidden, not transparent, absent from the render tree —
since anything left in the DOM behind the glass would draw underneath it and
never be seen anyway. Desktop and browser keep the original DOM controls with
CSS `backdrop-filter`, untouched. `updateGlassPanels` still rejects on
desktop/in-browser, so `nativeGlass` (and the DOM/native split it gates)
never flips there. The rect push to `update_glass_panels` continues
unchanged — native still needs the frame, now also draws into it.

Verified on an iPhone 17 Pro simulator (iOS 26.4) by screenshot only: both
panels render as translucent frosted glass with the map blurring through
underneath, and every label and glyph in the native content stays sharp.
**On-device tap-through was NOT performed** — installing simulator-automation
tooling to script taps was ruled out of scope. Instead, the `zoomIn` /
`zoomOut` / `hourChanged` plugin-event wiring (zoom stepping 0.25 and
clamping to 1–2.5; hour driving the heatmap) is covered by a unit test in
`tests/explore/ExploreMap.test.tsx` that mocks the plugin event source —
not by an on-device tap.

**Follow-up.** `.explore-map-pane` has been `display: none` below 1180px since
the original Explore page (#81), pre-dating this change and untouched by it.
No iOS phone viewport clears that width, so today the map — and every glass
panel this ships — never reaches an iOS phone; the on-device verification
above only exists because the breakpoint was overridden locally for the
screenshot, then reverted. This needs a separate mobile map layout task before
it is user-visible.
