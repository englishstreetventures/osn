---
"@cire/organiser": patch
---

Re-order the schedule by dragging, not by clicking arrows.

The host dashboard's Schedule → Edit list had a ▲/▼ button pair on every event
row. Those are replaced by a grip handle you drag, built on
[solid-dnd](https://github.com/thisbeyond/solid-dnd) — `DragDropProvider` +
`DragDropSensors` + `SortableProvider` + `createSortable`, with `closestCenter`
for a single-column list. It's a native SolidJS library, so there's no adapter
layer.

The row registers via `sortable.ref` and applies
`maybeTransformStyle(sortable.transform)` itself, with `sortable.dragActivators`
spread onto the grip — deliberately not the `use:sortable` directive, which would
make the whole row the drag affordance and swallow text selection along with the
row's own Edit/Delete buttons. The draft store follows suit:
`moveEvent(key, ±1)` becomes `reorderEvents(from, to)`.

**solid-dnd ships a pointer sensor only — no keyboard sensor, no
announcements.** Dragging alone would therefore have made this an accessibility
regression on the arrows it replaces, so the list supplies that path itself: the
grip is a real `<button>` handling Arrow Up/Down, focus is restored explicitly
after a move (a keyed `<For>` moves the row's node, but a DOM move is
remove-then-insert and focus doesn't reliably survive it), every move is
announced through a polite `role="status"` live region, each grip's `aria-label`
carries its current position, and an `aria-describedby` hint states the
arrow-key affordance. `touch-action: none` on the handle keeps touch drags from
being eaten by scrolling.

Measured cost on the organiser's main chunk: **+13.1 KiB raw / +4.3 KiB gzip**
(474,925 → 488,348 B raw). No code-splitting is needed — the chunk stays under
Vite's 500 KiB warning, with ~23 KiB of headroom.

Frontend-only: no API, schema or `sortOrder` semantics change.
