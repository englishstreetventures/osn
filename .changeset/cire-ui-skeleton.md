---
"@cire/ui": minor
---

`@cire/ui/skeleton` adds `Skeleton`, the pulsing block a list or a panel shows in place of its rows, cards or controls while it loads: `standsFor` `card` (the default, 16px, the full surface), `row` (6px, the full surface), `field` (14px, the surface at 60%) or `pill` (the surface at 60%), no edge, `aria-hidden` with no role, and the caller's `class` last for its size and place. `Loading` and `Skeleton` pulse on one pulse that reads the app's motion tokens — 2s scaled by `--motion-scale`, on `--ease-in-out` — rather than Tailwind's fixed `animate-pulse`, so `Loading` in both portals now eases on the house in-out curve.
