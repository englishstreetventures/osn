---
"@cire/host": patch
---

All seven of `cire/host`'s hand-rolled overlays become `<Modal>`

`PreviewModal`, `EnquireDialog`, `ImageCropModal`, the `ChangePreview` sheets in
`GuestsEditor` and `EventsEditor`, `DirectoryBrowseView`'s detail dialog and
`EventsEditor`'s event drawer. Each deletes a `fixed inset-0` scrim, a
`z-index`, a `<Portal>` and hand-written dialog ARIA; `DirectoryBrowseView` also
loses a `tabIndex={-1}` with a focusing `ref` and a keydown handler whose only
job was Escape.

Every one of them was portalled for the same stated reason — the dashboard shell
sets `container-type` on its layout boxes, which brings `contain: layout` and
makes them the containing block for `position: fixed` descendants. A top-layer
dialog is outside every stacking context, so there is nothing left to escape.

Five of the seven gain a focus trap and Escape they never had.

`ImageCropModal` keeps its caller's `<Show>`: all three call sites `lazy()` it
because it drags `cropperjs` in, and mounting it to preserve an exit animation
would defeat that. It is the one shape where unmounting the dialog is right.
