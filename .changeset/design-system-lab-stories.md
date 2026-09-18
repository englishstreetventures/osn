---
"@tools/lab": minor
"@shared/design-tokens": patch
---

Make the design system explorable in the lab.

A new `design-system/` story group under `tools/lab/src/stories/`, five files,
fourteen stories: the colour roles, the type/tracking/leading/measure scales,
radius, elevation, the focus ring, motion, and the theming demonstration.

Two things separate these from a token table rendered in HTML.

**They measure what the browser painted, not what the stylesheet claims.**
`measure.ts` reads computed style and re-reads it on a `MutationObserver` for
`<html>`'s `class` — so the numbers beside every swatch are the current theme's
real values, and the contrast story puts a live ratio and a pass/fail beside all
43 pairs `contrastPairs()` generates. The conformance harness reads the
stylesheet and cannot see a token an app set at runtime, a subtree that
redefined one, or which theme the toggle is on. This can. It shows musubi's two
waived pairs failing in red, because a waiver suppresses an assertion rather
than the defect.

**The theming story renders the same components under three mappings at once** —
musubi's, cire's, and every token set to `initial` so the package fallbacks show
— side by side, with only the musubi column following the light·dark toggle.
That is the whole claim `@theme inline` makes: `bg-ui-surface` resolves at the
element, so a subtree that redefines a token is followed. It is the property the
contract rests on and the one thing no static table can show.

Groups and membership are derived from `CONTRACT_COLOR_TOKENS` and
`CONTRACT_SCALES` rather than typed out, so a token added to the contract lands
in a group — or in a visible `unsorted` row, never silently nowhere.

Also corrects the last of the `--osn-*` → `--ui-*` rename: the glob form
`--osn-*`, which the suffix allowlist could not match, survived in twelve prose
sites including `tokens.css`'s own integration example.
