---
"@musubi/social": patch
"@osn/auth-ui": patch
"@tools/lab": patch
---

Musubi's stylesheet takes on the base rules its screens were missing. Readable small text (handles, statuses, hints, "Loading…" lines) moves from `text-subtle` to `text-muted-foreground`, and `--subtle` darkens to `#8d8d8d` in light so the icons and ornaments that keep it clear 3:1 on every ground; the contrast contract now holds `--ui-ink-tertiary` without a waiver. Text fields take an 8px corner (`--ui-radius-field`) while buttons stay pills. A bare `border` draws the hairline instead of ink, and a bare-bordered field the field edge. Every element reached from the keyboard gets the house focus outline, drawn inside the box where a row would clip it (the bottom bar, section tabs, the theme menu). `transition-ui-colors` replaces `transition-colors`, so the outline lands at once. The legal pages' body sits on Musubi's type scale through `.prose-legal`. `@osn/auth-ui`'s `DESIGN.md` records how those base rules reach its views in Musubi. The lab drops its copy of `transition-ui-colors`, which it now takes from Musubi's stylesheet, and its radius stories say Musubi's fields are 8px.
