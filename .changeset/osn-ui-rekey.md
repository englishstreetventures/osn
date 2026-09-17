---
"@shared/ui": minor
---

Re-key every `@shared/ui` primitive onto the `@shared/design-tokens` contract.
Fifteen components; `grep -rE '(bg|text|border|ring)-(background|foreground|card|popover|primary|secondary|muted|accent|destructive|input|ring)' shared/ui/src/ui` now returns nothing.

The `base:` mechanism is unchanged — the built CSS is still
`:where(.base\:bg-ui-ground){background-color:var(--ui-ground,#fff)}`, so
component defaults keep zero specificity and a consumer's own class still wins.

**This fixes a live defect as a side effect.** The destructive `Button` and
`Badge` hard-coded `base:text-white`, so they never read
`--destructive-foreground` at all — meaning the dark-mode contrast fix in
`@musubi/social` and `@pulse/web` was inert for the two components it was
meant to protect. Both now use `text-ui-on-danger` and pick it up.

Two mappings worth recording, because the obvious reading is wrong. shadcn's
`--accent` is a **neutral** in both consuming apps, so `bg-accent` and
`focus:bg-accent` map to `bg-ui-surface-sunk`, not to `--ui-accent-soft`,
which means a tint of the accent. And `hover:bg-primary/90` keeps its opacity
as `hover:bg-ui-accent/90` rather than moving to `--ui-accent-strong`: the
named token is a different colour from a 90%-opacity primary, and this change
is not allowed to alter how anything renders. `--ui-accent-strong` stays part
of the contract for product components that want a real hover colour.

`bg-black/50` on the dialog scrim stays a literal. A scrim is black in both
themes; it is not a theme colour and the contract has no role for it.

One test moved with it: `ProfileSwitcher` picks the confirm button out of two
"Delete" buttons by variant, so its class check is now `ui-danger`. The
assertion is unchanged in substance.
