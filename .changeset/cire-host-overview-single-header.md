---
"@cire/host": patch
---

Overview stops printing its own name and description under the shell's.

The host Overview read "Overview / Your wedding at a glance / OVERVIEW / Your
wedding at a glance" before any content, at every width. `ModuleShell` renders a
panel header for every module — an `<h2>` of the module's label and a `<p>` of
its `hint` — and Overview then led with a `SectionIntro` carrying the same two
strings word for word. The `SectionIntro` goes; the shell header stays, which is
what every other module already shows.

The sentence under the old title goes with it ("The headline numbers — how long
to go, who's replied, and what's next. Dig into any module from the sidebar."):
it was a third line of preamble above the numbers it described.

`module-nav.ts` is untouched. Its `hint` is one string with four readers — the
rail's tooltip, the narrow sheet, the command palette and this panel header — so
rewording it to dodge a collision with one page's own title would have changed
the other three for no reason.

`Overview.header.test.tsx` renders the real shell around the real Overview,
which is the only place the duplicate existed: the phrase now appears exactly
once, the module is named once above the content, and every module's header is
checked against `MODULE_NAV` so the shared header still names all of them.
