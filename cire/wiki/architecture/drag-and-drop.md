---
title: "Drag and drop — solid-dnd, and the keyboard path we own"
tags: [architecture, organiser, frontend, accessibility]
related:
  - "[[index]]"
  - "[[guest-event-editor]]"
  - "[[monorepo-structure]]"
last-reviewed: 2026-07-30
---

# Drag and drop — solid-dnd, and the keyboard path we own

Drag-to-reorder in the organiser portal uses
[solid-dnd](https://github.com/thisbeyond/solid-dnd) (`@thisbeyond/solid-dnd`).
It's a purpose-built SolidJS library, so there is **no adapter layer** — the
primitives are used directly in the component.

## Why solid-dnd, and what it costs us

Three candidates were weighed (2026-07-30):

| Library | Verdict |
|---|---|
| **solid-dnd** | **Chosen.** Native Solid, ships sortable-list primitives + collision detection. Measured main-chunk cost **+13.1 KiB raw / +4.3 KiB gzip**. |
| [neodrag](https://github.com/PuruVJ/neodrag) | **Can't do the job.** It's a free-positioning *draggable* — no droppables, no collision detection, no reorder logic. Sortable lists would mean hand-writing the hit-testing and index projection. Actively maintained, but that doesn't help when the capability is absent. |
| [dnd-kit](https://github.com/clauderic/dnd-kit) | Works (shipped briefly), but React-only adapters meant maintaining our own Solid adapter, and at ~105 kB raw it pushed the organiser's main chunk past Vite's 500 kB warning and forced a `lazy()` code-split. |

**The known risk, stated plainly: solid-dnd's last release was 0.7.5 in November
2023 — nearly three years unmaintained.** It was adopted anyway because it is
small, has zero runtime dependencies, and is pure DOM + geometry, so there's
little for ecosystem churn to break. That reasoning is only worth anything if
it's *checked*, so `EventsEditor.reorder.test.tsx` drives a real synthetic
pointer drag end-to-end (sensor → collision detection → `onDragEnd` → commit)
rather than merely asserting that the markup renders. If a Solid upgrade breaks
the library, those tests fail. If it does become unworkable, the blast radius is
one component — the DnD wiring is not abstracted across the codebase.

## The primitives

```tsx
<DragDropProvider onDragEnd={handleDragEnd} collisionDetector={closestCenter}>
  <DragDropSensors />
  <ul>
    <SortableProvider ids={keys()}>
      <For each={rows}>{(row, i) => <Row … />}</For>
    </SortableProvider>
  </ul>
</DragDropProvider>
```

`closestCenter` is the right detector for a single-column list. Inside a row:

```tsx
const sortable = createSortable(props.row.key);
<li ref={sortable.ref} style={maybeTransformStyle(sortable.transform)}>
  <button {...sortable.dragActivators} onKeyDown={handleKeyDown}>⠿</button>
</li>
```

### `ref` + `dragActivators`, not `use:sortable`

solid-dnd's `use:sortable` directive registers the node **and** attaches the drag
activators to it **and** applies the transform — i.e. the whole row becomes the
drag affordance, which would swallow text selection and the row's own buttons.

For a **handle**, use `sortable.ref` instead and spread `sortable.dragActivators`
onto the handle. The catch: `ref` registers the node *without* applying the
transform (see `createSortable` — only the directive form sets up that effect),
so the row must apply `maybeTransformStyle(sortable.transform)` itself. Use
`maybeTransformStyle`, not `transformStyle`: it returns `{}` when there's no
transform instead of writing an identity one.

Spread `dragActivators` **before** your own `onKeyDown` — later props win in
Solid's spread, so putting it last would let a future sensor clobber the keyboard
handler.

## Accessibility — this is the part to not break

**solid-dnd has no keyboard sensor and makes no announcements.** Grepping its
bundle for `keydown`/`keyboard`/`ArrowUp` returns zero hits. (Neither does
neodrag.) Swapping ▲/▼ buttons for dragging is therefore an accessibility
*regression* unless the whole keyboard story is supplied by hand. The list does
five things itself — if you touch this component, none of them are optional:

1. **The grip is a real `<button>`** — tabbable, and it owns an `onKeyDown` that
   moves the row on **Arrow Up / Arrow Down**, with `preventDefault()` so the page
   doesn't scroll out from under it. `preventDefault` runs *before* the bounds
   check, so a focused grip owns the arrows unconditionally rather than sometimes
   moving the row and sometimes scrolling.
2. **Arrow keys alone are NOT enough, and this is the subtle one.** NVDA and JAWS
   run in browse mode by default and consume unmodified arrow keys for their own
   virtual cursor; they forward them to a plain `<button>` only in focus mode,
   which buttons don't trigger. A screen-reader user would read the hint, press
   the arrows, and get nothing. So each row also renders **`sr-only` "Move X up" /
   "Move X down" buttons**, activated by Enter/Space — the one keystroke class
   browse mode reliably forwards, and precisely what the removed ▲/▼ pair used.
   They are `focus:not-sr-only` so a sighted keyboard user never lands on an
   invisible control (WCAG 2.4.7), and `disabled` at the list ends so AT reports
   the boundary instead of the user pressing into nothing.
3. **Focus is restored explicitly** after a keyboard move. `<For>` is keyed, so the
   row's node is *moved* rather than re-created — but a DOM move is a
   remove-then-insert and focus does not reliably survive it. Without the explicit
   `.focus()`, one keypress moves the row and then focus is on `<body>`, so the
   row can't be walked further.
4. **Every move is announced** through a polite `role="status"` live region
   ("Ceremony moved to position 2 of 3"), and each grip's `aria-label` carries its
   current position with an `aria-describedby` hint pointing at the shared
   instructions. A drag affordance is invisible to a screen-reader user otherwise.
   The announcement **clears before it sets** — a live region only speaks when its
   text changes, and walking one row down the list repeatedly produces the same
   sentence every time, so setting it straight would make the second press silent.
   Undo/discard clear the region rather than re-announcing, since an undo may have
   reverted a field edit rather than a re-order.
5. **Auto-repeat is ignored** (`if (event.repeat) return`). One press, one move —
   matching the click semantics of the buttons this replaced. Repeat fires ~30×/s
   and each move is a `structuredClone` draft checkpoint plus a full revalidation,
   so a held key would both stall the list and burn the 100-slot undo stack in a
   few seconds, silently discarding the edits the organiser actually wants back.

Also required: `touch-none` (CSS `touch-action: none`) on the handle, or the
browser scrolls instead of handing the gesture to solid-dnd; and enough padding to
clear the WCAG 2.5.8 24 px minimum target (`px-1 py-2` on a glyph this small).

## Testing drag in happy-dom

happy-dom does no layout — every `getBoundingClientRect()` is zeroes, so
`closestCenter` sees every row's centre at (0,0) and picks a collision
arbitrarily. `EventsEditor.reorder.test.tsx` works around this by stubbing
`Element.prototype.getBoundingClientRect` to return stacked rects derived from
each row's *current* DOM position (so they stay correct after a reorder), then
dispatching `pointerdown` → `pointermove` × 2 → `pointerup`. The first move gets
past the sensor's activation threshold.

The keyboard path needs none of that and is fully deterministic — it's the
cheaper regression net of the two.

What this still can't cover: drag *feel*, the shift/settle animation, and the
grip's hover/focus styling. Those need a real browser.

## Scope + open follow-ups

Current adopters:

- **Schedule → Edit** (`EventsEditor`) — see `[[guest-event-editor]]` E7.

Still on arrow buttons:

- `ChecklistView` — tasks within a lead-time bucket, persisted via
  `tasks/reorder`. It reorders *within a bucket*, so adopting this means using
  solid-dnd's multi-container support (a `SortableProvider` per bucket), which the
  events list doesn't exercise.
