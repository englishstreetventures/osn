---
"@osn/social": minor
---

Redesign the app UI on an SF Pro + grey-ink system.

New locked design system (recorded in `osn/social/DESIGN.md`): SF Pro via the
system stack (regular/medium, -0.15px tracking), a four-size type scale
(12/13/14/24, exposed as `text-meta/body/title/display`), a three-grey ink
hierarchy (#292929 / #5D5D5D / #9E9E9E, red kept for destructive only), two
corner radii (8px controls/nav, 16px card surfaces) plus pill CTAs, and icons
at 14px (nav) / 20px (content). Scoped to `@osn/social` — the shared `@osn/ui`
primitives are untouched (their `base:` zero-specificity variant lets the app
override at call sites), so cire and pulse are unaffected.
