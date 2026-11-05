---
"@cire/ui": patch
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/vendor": patch
---

`@cire/ui` gains `SkeletonOutline` (`@cire/ui/skeleton-outline`): a loading placeholder that is the view's own row, rendered from a typed sample and drawn hollow. Each run of words is a bar the height of its letters, one per wrapped line with a 4px corner at both ends; a boxed control or a meter, or a part marked `data-skeleton="block"`, is one block, and a button marked `data-skeleton="text"` (`CardCtaButton` now carries it) draws its words; a glyph is a small block; frames, hairlines and grounds stay as they are. Everything it draws is the ink at 10% and pulses on the loaders' timing. It moves each run of words into an inline span once and lets CSS draw the rest, so nothing is measured. The guest site, the marketing site and the vendor portal leave it out of their Tailwind scan. The host's `DESIGN.md` records the look (§4, Hollow rows; §7).
