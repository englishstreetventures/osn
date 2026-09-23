---
"@cire/host": patch
---

The organiser portal's module icons are now drawn icons at one size, and each
one says what its module is.

They were single Unicode characters (`◈ ◇ ✓ $ ⬡ ⊞ ✎ ✦ ✧`) sized three different
ways. Unicode has no shopfront, gift box or plain gear at a matching weight, so
they are now `lucide-solid` icons, imported one at a time: a calendar for
Events, a checklist, a piggy bank for Budget, a shopfront for Vendors, a gift box for Registry, people for Guests, an open envelope for
Invite and a gear for Settings. Overview keeps its `◈`, redrawn as an SVG in
the same stroke so it matches the set.

Every surface that marks a module — the rail, the narrow sheet and its trigger,
the command palette and Overview's agenda — draws the icon through one
`ModuleIcon` component at one size token, `--size-icon: 1.125rem`, a little
larger than before. The command palette's other rows (weddings, theme,
security, sign out) moved to the same set so the list reads as one system.
Every icon stays `aria-hidden`; the row's text carries the meaning.

The bundle grows by 3007 bytes gzip, and the `cire/host` size budget is
re-baselined to 252653 bytes.
