---
"@cire/web": patch
---

Tighten the invite's typography and click affordances.

Display headings are now upright rather than italic, and the two hardcoded gold
uppercase labels above the welcome greeting are folded into the greeting itself,
so the page carries far fewer competing micro-labels. On each event card
"Respond" is now the one filled button and the second button reads "Event
Details", so the act the invite exists for is the obvious one.

Every clickable control says so under the pointer again — Tailwind v4's preflight
drops the browser's own `cursor: pointer` on `<button>`, which left every button
on the invite reading as inert text. Text fields get a caret, disabled controls
get the blocked cursor, and keyboard focus is now visible on every control from
the base layer.

Guests who ask their device for reduced motion get the post-claim reveal with no
choreography: same content, no animation. Dialogs open and close the same way —
the animation library drives the Web Animations API, which ignores the CSS
reduced-motion overrides, so the guard has to live in the JavaScript. Delays are
cut alongside durations now, with the loading spinner exempted so it keeps
turning rather than freezing into a static ring.

The hero preload asks for the one variant the page actually paints, instead of a
set that made the browser fetch a second, sharper render at top priority and race
the real image for the connection. The hero can also grow past the
viewport when a couple's title is long instead of clipping it, the page can no
longer pan sideways on a small screen, and the invite signs off in the couple's
name above the legal links.
