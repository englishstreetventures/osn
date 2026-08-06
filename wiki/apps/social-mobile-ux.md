---
title: Social — Mobile UX analysis & plan
description: Why @osn/social is unusable on phones today, and the phased plan to fix it
tags: [app, identity, ux, mobile, plan]
status: shipped
packages:
  - "@osn/social"
related:
  - "[[social]]"
  - "[[authorize-ui]]"
  - "[[component-library]]"
last-reviewed: 2026-08-06
---

# Social — Mobile UX analysis & plan

`@osn/social` (live on the apex `musubi.social`) was designed as a desktop
left-rail workbench and had **no responsive behaviour at all**. On a phone it
was effectively broken: the fixed 240 px sidebar always rendered, leaving
~135 px of content on a 375 px viewport. This page is the audit of what was
wrong and the phased plan that fixed it, scoped to the app only (per
`DESIGN.md`, the shared `@osn/ui` primitives are never edited — cire and
pulse consume them too).

> **Superseded in one detail (2026-08-02):** the tab bar now carries a fifth
> destination, **Search** (`/search`), because search is the one surface whose
> reachable spot differs by shell — the desktop rail got a live combobox, and a
> header field on mobile is the least thumb-reachable place a search box can
> go. `NAV_ITEMS` gained a `mobileOnly` flag so the rail filters it out. See
> `DESIGN.md` §Responsive layout and [[social-graph]].
>
> **All five phases shipped 2026-07-28** in the same PR as this audit.
> The findings below are kept as the record of the pre-fix state; the Plan
> section now doubles as the implementation map. Key artefacts:
> `src/components/nav.tsx` (shared nav source), `MobileNav.tsx` (bottom tab
> bar), `MobileTopBar.tsx` (mobile header), `ResponsiveDialogContent.tsx`
> (bottom-sheet dialog face), `AccountMenu` / `AuthDialogs` /
> `ProfileSwitcherDialog` (account UI shared by the shells — only the
> active shell mounts, gated on an `md` matchMedia signal in `Layout`,
> which also keeps the auth-dialog surface single-instance), safe-area +
> `pb-nav` utilities and the 16 px mobile-input rule in `App.css`, and a
> **Responsive layout** section in `DESIGN.md` that locks the system
> (single `md` breakpoint, `max-md:` touch-target mechanism, sheet dialogs,
> top-center mobile toasts). Verified headless-Chromium at 320/390/768/1280
> widths — zero horizontal overflow, both themes; `/authorize` untouched.
>
> **Prep-pr review round (2026-07-28):** security pass (S-L1 duplicate
> dialog mounts → resolved structurally by single-shell mounting; C-L1
> nav icons now `aria-hidden`), perf pass (P-W1 both shells always
> mounted → conditional mount + one `MobileChrome` chunk; P-I1 duplicate
> dialog/memo work → falls out of P-W1; P-I2 `useIsMobile` first-frame
> flip → synchronous matchMedia init), tests (T-M1/T-M2/T-U1/T-U2/T-S1
> written; T-S2 Layout-composition test deferred — `AuthProvider`
> bootstraps a network `POST /token`, so it needs a heavier fixture).

Platform priority is **iOS > Web > Android** (CLAUDE.md), so mobile Safari is
the primary target for every fix below.

## Findings

Severity uses the review convention (H/M/L). File refs are current as of
2026-07-27.

### F1 (H) — No responsive app shell

- `src/components/Sidebar.tsx:148` — `<aside class="… h-screen w-60 shrink-0">`
  renders at every viewport width. `src/App.tsx:50` wraps everything in
  `flex h-screen overflow-hidden`.
- The entire app contains **three** responsive utilities (two `sm:grid-cols-2`
  in `DiscoverPage`, one `hidden sm:block` in `OrganisationsPage`). There is no
  breakpoint story, no hamburger, no bottom nav.
- Result: on 320–430 px phones the content column is a sliver; rows with
  trailing buttons (Accept / Decline) wrap or clip.

### F2 (H) — Viewport units and safe areas

- `h-screen` (100vh) on the root and the rail mis-sizes under iOS Safari's
  dynamic toolbars — the page bottom sits under the toolbar until scroll.
  Needs `dvh`.
- `index.html:5` viewport meta lacks `viewport-fit=cover`; nothing anywhere
  uses `env(safe-area-inset-*)`. A future bottom nav would sit under the home
  indicator; landscape notches eat content.
- No `theme-color` meta, so the iOS Safari chrome doesn't match either theme.

### F3 (H) — iOS auto-zoom on every input

The type scale is locked to 12/13/14/24 px and inputs render at `text-body`
(13 px) / `text-sm` (14 px). Mobile Safari zooms the page when a focused
input's font-size is under 16 px — so every dialog form (org create, sign-in
identifier, OTP) triggers a zoom the layout never cleanly recovers from.
Fix with an app-scoped small-viewport rule bumping form controls to 16 px —
**not** `maximum-scale=1`, which breaks accessibility zoom.

### F4 (H) — Touch targets far below 44 px

Apple HIG floor is 44 pt (Material: 48 dp). Today:

- Row action buttons are `h-7` (28 px): Remove / Accept / Decline / Connect /
  Unblock (`ConnectionsPage.tsx:192,233`, `DiscoverPage.tsx:108`,
  `SettingsPage.tsx:212`).
- `size="sm"` buttons are `h-8` (32 px); tab buttons are text + `pb-2.5`
  (~30 px); sidebar nav rows are ~34 px with 14 px icons.

### F5 (H) — Dialogs are desktop-centered modals

All six `Dialog` call sites (register, sign-in, profile switcher, remove-friend
confirm, org create, org edit) use the Kobalte fixed-centered content
(`w-full max-w-*`, `top-50%/left-50%`) with **no side gutter, no max-height,
no internal scroll**. On phones: edge-to-edge cards with clipped corners, and
the soft keyboard covers the lower half of centered forms with no way to
scroll. Mobile needs the bottom-sheet pattern.

### F6 (M) — Hover-only affordances

Every list row and nav item signals interactivity purely via `hover:` classes,
which never fire on touch. No `active:` feedback anywhere, and tap highlights
are the browser default. The account dropdown lives at the bottom of a rail
that won't exist on mobile.

### F7 (M) — Density and chrome placement

- Every page main is `px-8 py-8` — 64 px of horizontal padding is 17% of a
  375 px viewport.
- `Toaster position="bottom-right"` (`App.tsx:62`) collides with the keyboard
  and any bottom nav on mobile.
- Settings has four tabs ("Connected apps" is long) in a non-scrolling flex
  row — overflow at narrow widths.

### F8 (L) — Small stuff

- No `touch-action: manipulation` on controls (double-tap zoom delay on some
  browsers).
- Pending-request rows put name + two buttons on one line; verify truncation
  at 320 px after the target-size bump.
- `AuthorizePage` is already the mobile-friendliest screen
  (`max-w-md px-6`, bare route) — it only needs the F2/F3 foundations, and the
  shell work must not touch the `/authorize` bare-route path.

## Plan

Five phases, each independently shippable, ordered so foundations land before
layout. Everything is `@osn/social`-scoped: `App.css`, call-site classes
(the `base:` zero-specificity variant in `@osn/ui` makes call-site overrides
win), and new app-local components. **No edits to `@osn/ui` primitives.**
`DESIGN.md` is the locked system — phases that extend it amend the file in the
same PR.

### Phase 0 — Viewport & input foundations (fixes F2, F3, F8; small)

- `index.html`: add `viewport-fit=cover` to the viewport meta; add paired
  `theme-color` metas (light `#ffffff` / dark `#1c1c1c`) kept in sync with the
  pre-paint theme script.
- `App.css`: safe-area utilities (`pb-safe`, `pt-safe` from
  `env(safe-area-inset-*)`); a `@media (max-width: 767px)` rule raising
  `input, textarea, select` to 16 px; `touch-action: manipulation` +
  `-webkit-tap-highlight-color: transparent` on interactive elements.
- Swap `h-screen` → `h-dvh` in `App.tsx` and `Sidebar.tsx`.
- Zero visual change on desktop; unblocks everything after it.

### Phase 1 — Responsive shell: bottom tab bar (fixes F1; the big one)

Breakpoint policy: **one breakpoint, `md` (768 px)**. Below it the app is a
mobile shell; at and above it, today's rail is unchanged.

- Extract `NAV_ITEMS` + icons from `Sidebar.tsx` into `src/components/nav.tsx`
  (single source for both shells).
- New `MobileNav.tsx`: fixed bottom tab bar (`md:hidden`), the four nav items
  with 20 px icons + `text-meta` labels, ≥48 px item height plus `pb-safe`,
  active state = `text-foreground` vs `text-subtle`.
- New `MobileTopBar.tsx`: slim sticky header (`md:hidden`) with the
  OSN · Social wordmark, `ThemeToggle`, and the account control — avatar
  opening the existing dropdown (switch profile / log out) when signed in,
  a pill "Sign in" button (opening the existing dialogs) when signed out.
- `Sidebar.tsx` gets `hidden md:flex`; `Layout` renders both shells and gives
  the content column bottom padding of nav height + safe area on mobile.
- Bare `/authorize` route keeps rendering with no shell at any width.
- Tests: extend `tests/components/Sidebar.test.tsx`; new `MobileNav` test
  (items render, active state, hidden on the bare route).

### Phase 2 — Bottom-sheet dialogs (fixes F5)

- New app-local `ResponsiveDialogContent` wrapping `@osn/ui`'s
  `DialogContent` with classes only: below `md` — pinned to bottom,
  full-width, `rounded-t-card` (square bottom corners), slide-up motion,
  `max-h-[85dvh] overflow-y-auto`, `pb-safe`; at `md+` — exactly today's
  centered card.
- Migrate all six dialog call sites; keyboard test each form on iOS Safari
  (identifier input, OTP boxes, org create textarea).
- Amend `DESIGN.md` radii section: sheets are the mobile face of dialogs,
  `rounded-t-card`.

### Phase 3 — Touch ergonomics & density (fixes F4, F6, F7)

- Row-level actions: keep desktop sizes at `md+`, bump to ≥40 px visual /
  ≥44 px effective on mobile via call-site classes (`h-7 md:h-7 max-md:h-10`
  style) or an app-scoped `@media (pointer: coarse)` rule — pick one mechanism
  and use it everywhere.
- List rows get `min-h-11` and `active:bg-muted` alongside the existing hover
  classes; tab bars (Connections, Settings) become `overflow-x-auto`
  no-wrap with ≥44 px tap height.
- Page padding `px-4 py-6 md:px-8 md:py-8` across the five pages.
- `Toaster`: top-center on small viewports (or bottom offset above the tab
  bar), bottom-right on desktop.

### Phase 4 — Verification & guardrails

- Viewport smoke tests (vitest + jsdom width shims where possible; a
  Playwright pass at 375×667 / 390×844 / 768×1024 if we add it): no
  horizontal overflow, nav reachable signed-in and signed-out, dialogs fit
  and scroll.
- Manual iOS Safari pass over the full journey: register → discover →
  connect → accept → org create → settings → sign out.
- `DESIGN.md` gains a **Responsive layout** section codifying: the single
  `md` breakpoint, bottom-tab shell below it, the 16 px mobile input
  exception to the four-size type scale, sheet dialogs, and the 44 px touch
  floor — so the locked system covers mobile from now on.

### Sequencing & sizing

| Phase | Depends on | Size |
| --- | --- | --- |
| 0 | — | S (one PR, no visual desktop change) |
| 1 | 0 | L (new shell components + tests) |
| 2 | 0 | M (one wrapper + six call sites) |
| 3 | 1 | M (mechanical sweep, many small edits) |
| 4 | 1–3 | S–M |

Phases 1 and 2 are independent of each other and can land in either order
after Phase 0.

## Non-goals (for now)

- Native wrapper — separate, already-deferred track.
- PWA install/offline — worth a look after the shell work, not part of it.
- Editing `@osn/ui` primitives to be responsive — cire and pulse own their
  breakpoints; everything here stays app-scoped.
- Redesigning the near-monochrome system — mobile inherits the same ink
  hierarchy, radii, and type scale (16 px input exception aside).
