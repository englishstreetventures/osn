---
"@shared/design-tokens": minor
---

New `@shared/design-tokens`: the token contract every shared component reads,
and the conformance harness that makes it a contract rather than a naming
convention.

`tokens.css` declares the `--ui-*` names as `@theme inline` aliases with
inline fallbacks, plus the `@source` and `@custom-variant base` directives
consumers would otherwise each have to remember. `inline` is what lets a
subtree redefine a token and have shared components follow it — a theme story
showing both themes at once, or cire's invite preview rendering a wedding's
palette inside the organiser's chrome. There is deliberately no `:root` block:
a package-level one is unlayered, lands at the import site, and would beat an
app mapping written inside `@layer base`.

`conformance.ts` is a rewrite of `cire/host/tests/styles/tokens.test.ts`, not
a move. That harness finds tokens by regex over literal `--name: oklch(…)`
declarations, which a contract mapping never is — it is `--ui-ink:
var(--text)`, two or three hops from a literal. Against a mapping the old
approach matches nothing and asserts about an empty set, so the substance
here is a `var()` resolver that follows the chain across theme scopes, plus
cycle detection. Alpha is composited over the ground before measuring, in
sRGB, because half the ink tokens in this monorepo are translucent and a
naive ratio overstates every one.

Contrast obligations are derived from the token grouping rather than listed
by hand: every body ink is measured against all five grounds and surfaces
(ink that clears 4.5:1 on the page and fails it on a raised menu is a real
defect the one-ground version cannot see), decorative tokens are held to no
floor, and on-fill ink is measured against its fill rather than the page.

28 tests, 14 of which assert the harness produces a failure — a contrast
guard that only ever goes green is indistinguishable from one that measures
nothing.

Colour half only. The type, tracking, leading and measure scales are a
separate decision and land next.
