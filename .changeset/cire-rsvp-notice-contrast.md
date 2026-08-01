---
"@cire/theme": patch
"@cire/web": patch
---

Fix the RSVP-by line failing WCAG AA contrast on a pale palette.

Reported from a live invite: "Kindly respond by …" measured **3.35:1** against
its section background (WCAG 1.4.3 asks 4.5:1 for 0.85rem text). Nothing was
broken in the organiser's palette — `--color-gold` is the *metal*, and
`derivePalette` deliberately holds it only to the 3:1 UI floor so a genuinely
gold gold isn't bleached into a cream. Painting a sentence with it was the bug.

`@cire/theme` now derives **`--color-gold-ink`**: the same hue walked to the
text minimum against all three surfaces (`ground`, `card`, `raised`), since a
section's tone is the organiser's pick and any of them can be the backdrop.
`--color-gold` is untouched, so rules, borders, buttons and display headings
keep the colour that was chosen. `--color-text-muted` — which paints the same
line once RSVPs close, and every venue/description on the page — moves from the
3:1 UI floor to the same three-surface text minimum; it is a derived grey nobody
picks, so nothing of the scheme is spent enforcing it (the same live palette had
it at 4.36:1).

On the guest site the RSVP-by line (both design packs) and the event-card date
switch to `text-gold-ink`. The date closes **C-M2**, which had the `chapel` and
`garden` presets shipping it at 3.58:1 and 3.91:1. All five curated presets are
unchanged on `evergreen`/`jewel`/`fog` and clear 4.5:1 everywhere.
