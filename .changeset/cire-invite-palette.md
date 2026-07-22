---
"@cire/theme": minor
"@cire/api": minor
"@cire/db": minor
"@cire/web": minor
"@cire/organiser": minor
---

Replace the invite's eight per-section theme colours with a five-colour scheme.

The builder used to ask an organiser for an accent and a surface for each of
hero / story / welcome / events. That is eight independent colours to make hang
together, and they still only reached five of the guest site's thirteen design
tokens — the page background, borders, text, muted text and the hero gradient
were locked, hero and story applied the raw `--invite-*` variables instead of
the token bridge (so their `text-gold` / `border-border` utilities ignored the
chosen accent), and the footer sat outside every themed wrapper.

**Now:** the organiser names five colours by their role — `ground` (the page),
`card` (raised paper), `ink` (everything written), `gilt` (the metal) and
`bloom` (the festive counter-colour) — or picks one of five curated schemes.
`derivePalette` in `@cire/theme` turns those seeds into the whole token set and
the guest site applies it at the **document root**, so the scheme reaches every
section, both modals, the footer and the hero gradient. Per-section colour
pickers became a single per-section `tone` (`ground` | `card` | `raised`).

- **Contrast is enforced, not advised.** Derived text and accent tokens are
  nudged until they clear WCAG (4.5:1 text, 3:1 UI/focus) against the surfaces
  they sit on; a well-chosen seed is returned untouched, and the builder reports
  what it had to move. The old advisory warned and shipped an unreadable invite
  anyway.
- **One copy of the colour maths.** The organiser preview now imports the guest
  site's own derivation, so `invite-theme-preview.ts` and `lib/contrast.ts` are
  deleted along with the font-stack + default-token triplication they carried.
  The picker also reads `oklch()` now (via the shared parser), which is what
  every preset and derived token uses.
- **Same security boundary.** Seeds pass the same `isSafeCssColor` allow-list on
  write and are re-validated before derivation on render; a rejected seed
  degrades to the default preset instead of breaking the page. Derived values
  are emitted as `oklch(...)`, so they clear the same gate. Tones and preset
  keys are closed enums.

Migration `0044_invite_palette.sql` adds the seed / preset / tone columns,
back-fills the hero accent and surface onto `gilt` and `card`, preserves the
story band as `story_tone = 'card'`, and drops the eight old colour columns. A
wedding that set a divergent story/details/welcome accent loses that
divergence — the intended product change.
