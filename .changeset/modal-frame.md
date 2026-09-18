---
"@shared/ui": minor
---

`Modal` gains `frame`, and stops leaking the user agent's dialog padding

`frame` is for a panel that must not scroll: it drops the panel's own padding
and overflow and makes it a column flex container, so a child can own the
scrollport while a close button or a sticky action bar stays put beside it. The
default shape — the panel scrolls, the panel is padded — cannot express that,
because anything inside a scrollport scrolls away with the content.

`base:p-0` rather than simply omitting the padding, and that is the part worth
knowing: the user-agent stylesheet gives every `<dialog>` `padding: 1em`, so a
component that writes no padding rule ships a 16px band the caller cannot see in
its own markup. It put cire's sticky action bar 16px above the bottom edge it is
supposed to sit on.

Two fixes on the way out of a dialog, both found by the same conversion.
`close()` now dispatches the `close` event where the environment has no
`HTMLDialogElement.close` — without it the fallback shut silently and `open`
desynced, which is the one failure the component's close listener exists to
prevent. And `getAnimations` is guarded the way `showModal` already was, since
jsdom has no Web Animations API and the unguarded call was a `TypeError` on
every close.
