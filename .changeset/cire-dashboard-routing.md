---
"@cire/organiser": minor
---

Deep-linkable organiser dashboard routes + refresh persistence, and a
dismissable Getting-started checklist.

- **Hash-route scheme** (new `cire/organiser/src/lib/dashboard-route.ts`) — the
  full navigable state is encoded in the URL hash so a hard refresh restores it
  and a shared link reopens it:
  - `#/weddings` → the wedding list
  - `#/weddings/<weddingId>` → that wedding, default tab (events)
  - `#/weddings/<weddingId>/<tab>` → that wedding + a specific tab
    (`events`/`guests`/`invite`/`codes`/`hosts`)
  - `#/security` → the account-security view

  `parseRoute`/`serializeRoute` are small, dependency-free, total + defensive:
  unknown shapes fall back to the list, an unknown tab falls back to the default
  tab (keeping the wedding), and ids are percent-encoded so they round-trip. The
  default tab is left implicit so a wedding link stays short and canonical.
- **`OrganiserApp.tsx`** now owns a single `route` signal that is the source of
  truth for render and is mirrored into the hash. Opening a wedding / going back
  to the list / switching the top-level view `pushState`s (so Back/Forward walks
  them); switching tabs `replaceState`s (so they don't pile up history). A
  `hashchange` listener re-syncs on browser Back/Forward and manual edits, and a
  legacy/shorthand hash (`#security`, `#guests`, "") is normalised to the
  canonical `#/…` form on mount. **Not-authorised fallback:** once the wedding
  list loads, a hash naming a wedding the organiser can't load (not owner/host,
  or gone) drops back to the list rather than hanging.
- **`DashboardTabs.tsx`** is now a controlled component: it takes the active
  `tab` + an `onTab` callback from the parent instead of self-managing the hash.
  Owner-only `codes` stays gated — a co-host deep-linking `#/weddings/<id>/codes`
  resolves to a visible tab.
- **`GettingStarted.tsx`** gains an accessible **X / dismiss** button (label
  "Dismiss getting started"); dismissal is persisted per wedding in
  `localStorage` (`cire:getting-started-dismissed:<weddingId>`) so it stays
  hidden across reloads, with a small "Show getting started" affordance to bring
  it back. The data-derived done-state logic is unchanged.

Deeper sub-state (open modals, a selected guest row) is intentionally not
deep-linked yet — view + wedding + tab is the requirement. Tests: new
`dashboard-route.test.ts` (parse/serialize + round-trip + fallbacks), updated
`DashboardTabs.test.tsx` for the controlled component, and new `OrganiserApp`
coverage for restoring a wedding+tab from a hash on load, the not-authorised
fallback, hash updates on navigation, and `hashchange` re-sync; plus
GettingStarted dismiss/restore + per-wedding persistence. 130 organiser tests
green. ⚠️ Wants a real-browser eyeball on Back/Forward + a hard refresh on a
wedding tab (happy-dom can't fully exercise the history stack).
