---
"@cire/invites": patch
---

The guest site's sheet becomes a `Modal`, and the top layer rearranges what sits above it

`AnimatedModal` was a `fixed inset-0` backdrop at `Z_CLASS.MODAL`, a hand-written
`Tab` cycle, a document-level Escape handler, a saved `activeElement` to restore,
and two Motion One sequences in a chunk imported on first open. All of it is the
platform's now, and `Modal.motion` leaves the bundle with its prefetch.

What that changes is not only inside the sheet. A `showModal()` dialog paints in
the top layer and makes the rest of the document inert, so the two things that
must appear over the sheet could no longer do it by out-numbering it:

- **Add-to-Calendar** rendered in a `<Portal>` to `document.body` at `z-110`.
  Outside the dialog it is inert — visible and dead, which is the same bug report
  as #203 from the guest's side. It renders in place now and shows itself as a
  `popover`, which is what the portal was for: out of every ancestor stacking
  context, and this time out of the sheet's way too.
- **The save toast** uses `@shared/toast`'s new `topLayer`.

`Z_LAYER.MODAL` goes with all of it. Nothing paints at that layer any more, and
an entry claiming to rank against a top-layer dialog is a promise the scale
cannot keep. `MODAL_POPOVER` stays: it is what the menu falls back on when it is
opened from an event card rather than from a sheet.
