---
"@cire/theme": patch
"@cire/db": patch
"@cire/api": patch
"@cire/web": patch
"@cire/organiser": patch
---

Global invite typography options: heading size / weight / style + body
weight / style, with italics.

Five new **closed-enum** theme fields (migration `0048_invite_typography.sql`,
nullable columns on `wedding_invite_customisations`): `headingSize`
(`small | large`, a multiplier on each design pack's existing `clamp(...)`
curves), `headingWeight` + `bodyWeight` (`light | regular | bold` →
300/400/700 — the faces Cormorant Garamond and Lato actually ship, so no
faux-bold), and `headingStyle` + `bodyStyle` (`normal | italic`). `null` ⇒ the
pack's built-in look, so an un-configured invite renders pixel-identical.

The vocabulary and value maps live in `@cire/theme` (`typography.ts` —
`HEADING_SIZE_CHOICES` / `FONT_WEIGHT_CHOICES` / `FONT_STYLE_CHOICES` +
`typographyVars`), the single copy the API's `Schema.Literal` enums, the guest
root variables and the organiser preview all import. Only the KEY crosses the
wire; each resolves to a fixed CSS value, so nothing new crosses the
CSS-injection gate (an unknown key emits nothing and degrades to the default
look).

Guest render: `paletteRootVars` emits `--invite-heading-scale/-weight/-style`
+ `--invite-body-weight/-style`; the classic + gala packs' hero-title and
section-heading elements consume the heading vars with their former literals
as fallbacks, and `global.css`'s `body` rule applies the body pair by
inheritance (headings pin their own weight/style, so an italic body never
drags headings along). Font links now load the true 700s + italics for both
faces.

Organiser: five new selects in the Look fieldset (Default/…, `normal | italic`
style selects), riding the existing single-save dirty check and total theme
PUT; the section previews and the hero WYSIWYG title follow the same variables
so a pick is visible before saving. Copy/typography saves never bump
`images_updated_at` (guest image caches stay warm).
