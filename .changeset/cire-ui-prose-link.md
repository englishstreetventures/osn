---
"@cire/ui": patch
"@cire/host": patch
---

`proseLinkClass({ tone })` in `@cire/ui/button`: the classes for a link set inside a sentence. Inline, so it wraps with its sentence; underlined at rest at a 2px offset; no type size or weight of its own; `Button`'s focus ring; two inks, `accent` (readable gold, the default) and `muted` (the secondary ink, brightening on hover). `@cire/ui` gains a browser test tier (`bun run --cwd cire/ui test:browser`, Chromium), against a stand-in stylesheet that maps cire's two ramps. The host's `DESIGN.md` names it beside `Button`.
