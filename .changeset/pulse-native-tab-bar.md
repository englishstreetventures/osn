---
"@pulse/app": minor
---

Native iOS tab bar, replacing the DOM tabs on device.

A new `tauri-plugin-pulse-tabbar` crate installs a real `UITabBar` as a
subview of the `WKWebView` and keeps it in sync with the router both ways.
The bar's appearance is left untouched, so iOS 26 gives it Liquid Glass by
default — public API only, no `NSGlassEffectView` or other private surface.

The webview keeps its full frame; the bar is accounted for with
`scrollView.contentInset.bottom`, not frame surgery, so nothing is clipped
and rotation is handled by UIKit's own layout pass. The inset is measured as
`height - (adjustedContentInset.bottom - contentInset.bottom)` — a plain
`contentInset.bottom = height` would double-count the safe-area padding that
`contentInsetAdjustmentBehavior` already adds, and that the bar's intrinsic
size already includes.

Selection travels JS→native as a `set_selected_tab` command and native→JS
over a typed Tauri `Channel<TabSelected>`, taken as a top-level command
argument because `Channel` needs the `Webview` to deserialize and cannot be
nested inside a payload struct. The loop does not feed back on itself:
assigning `UITabBar.selectedItem` in code does not call the delegate.

`src/lib/tabs.ts` is now the single source of truth for both sets of tabs, so
the native bar and `ExploreNav` can never drift. `ExploreNav` hides its own
tab row once the native bar reports itself installed. Off iOS the plugin
returns `Unsupported`, the install call rejects, and the DOM tabs stay — no
user-agent sniffing anywhere.

The list is capped at five items: a sixth would make UIKit collapse the
overflow into a "More" tab, which has no route of its own and would break the
two-way sync.

## Verification

Run on an iPhone 17 Pro simulator (iOS 26.4) under `tauri ios dev`, rotated
portrait → landscape-left → portrait, with a screenshot at each stop.

**Verified.** The bar installs and draws. It stays pinned to the bottom edge
and horizontally centred in both orientations, unclipped, with its glyph and
label intact, and it survives rotation in both directions without any manual
re-layout. Page content reflows to the new width around it — header, hero
copy and the whole filter-pill row — with nothing cut off. iOS 26 draws
`UITabBar` as a floating capsule rather than a full-width bar; that is the
system's own rendering of a bar whose view is still constrained
leading-to-trailing, and it is what Liquid Glass looks like here. Only one
item shows in these shots because the session is signed out and
`NativeTabBar` filters the list down to `home` — see `src/lib/tabs.ts`.

**Not verified on device: the `contentInset` behaviour under a real scroll.**
The event list never loaded in the simulator (an unrelated data-path problem,
not this change), so the only thing near the bar was a centred empty-state
string. The inset arithmetic is covered by unit tests and by inspection —
`safeAreaInsetsDidChange` → `invalidateIntrinsicContentSize` → `layoutSubviews`
re-drives it on every rotation — but no populated, scrolling list has been
seen clearing the bar.
