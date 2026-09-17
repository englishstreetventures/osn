---
"@cire/host": patch
---

The Preview button, the RSVP save and three card CTAs stop being hand-written

`PreviewInviteButton` is the file this whole exercise started from: it and
`InviteBuilder`'s Preview control are the same outline-at-rest, gold-on-hover
button in the same portal, and only one of them was a `<Button>`. They had
drifted — this one rested on `border-gold-dim` and `text-gold`, where the `cta`
variant uses the accent and its contrast-checked ink.

The RSVP editor's Save was hand-written at `px-3 py-1.5` beside a Cancel that
was already a `<Button>` at the default size, so the two controls in one row
were different heights.

`@cire/ui` gains `CardCtaButton`, which is the `<button type="button"
class="self-start"><CardCta>…</CardCta></button>` wrapper that Overview was
writing out three times. `self-start` belongs on the button rather than the
span: a flex child stretches to the column's width, so without it the hit area
runs the full width of the card.
