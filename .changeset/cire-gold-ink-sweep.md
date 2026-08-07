---
"@cire/invites": patch
---

Sweep the rest of the invite onto the prose gold.

The follow-up to the RSVP-by line fix: 45 utility sites across 15 components,
plus 8 raw-CSS declarations in `SiteFooter.astro` and `LegalLayout.astro`, move
from `text-gold` to `text-gold-ink` — section eyebrows, control labels, modal
headings, the consent banner/gate/preferences links, the claim-code notices, the
legal pages' links and headings. Without it, a contrast scan of a pale invite
kept reporting the eyebrow sitting directly above the line that had been fixed.

The rule: **the metal paints borders, fills, icons and large display text; the
prose gold paints anything read below WCAG's large-text bar.** Sizes are measured
against the smallest each element can actually render at — the `clamp()` minimum
times the organiser's `small` heading scale (0.85), not the value read off the
class. That distinction is what separates gala's claim heading (20.4px at
`small`, so prose) from classic's (27.2px, so metal).

Five sites keep the metal deliberately: both design packs' hero couple names,
classic's claim heading, the 404 numeral, and the map pin — an SVG icon, which
is a graphical object at the 3:1 bar rather than text.

The consent dialog's "Always on" chip also loses its `/80` alpha along with the
swap. An alpha-modified colour over a surface has no single contrast ratio for
the derivation to enforce, so `text-gold-ink/80` would have looked fixed without
being fixed.

Guarded by a static source scan (`styles/gold-text-token.test.ts`) whose
allow-list is five explicit entries with a written reason each, rather than a
size heuristic — parsing `calc(clamp(…)*var(…))` to guess whether something
clears 24px is how a guard like this fails open. It is verified to fail when a
single swap is reverted.
