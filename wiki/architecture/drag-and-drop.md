---
title: "Drag and drop — @shared/sortable, and the keyboard path it owns"
tags: [architecture, organiser, frontend, accessibility]
related:
  - "[[index]]"
  - "[[cire-guest-event-editor]]"
  - "[[monorepo-structure]]"
  - "[[toast]]"
  - "[[component-lab]]"
last-reviewed: 2026-08-21
---
# Drag and drop — `@shared/sortable`, and the keyboard path it owns

Drag-to-reorder uses **`@shared/sortable`**, an internal package. It replaced
[solid-dnd](https://github.com/thisbeyond/solid-dnd) (`@thisbeyond/solid-dnd`)
on 2026-08-21.

## Why we own it now

This page used to say the opposite — that solid-dnd was used directly, with no
adapter layer, and that the blast radius was one component. That was a
defensible call, and the reasoning is kept below because it is still the reason
the swap was cheap. Two things changed it.

**The library was three years unmaintained.** Its last release was 0.7.5 in
November 2023. It was adopted anyway because it is small, has zero runtime
dependencies, and is pure DOM plus geometry — but that argument only ever
deferred the question.

**The accessibility cost was blocking adoption.** solid-dnd ships a pointer
sensor and nothing else: no keyboard sensor, no announcements. Grepping its
bundle for `keydown`/`keyboard`/`ArrowUp` returns zero hits. So every list that
wanted dragging had to hand-write the whole keyboard and screen-reader story —
about 120 lines of subtle, silent-when-wrong logic. `EventsEditor` did. Three
other lists did not, and said so in code: `RegistryView.tsx` carried the comment
*"solid-dnd ships no keyboard sensor and no announcements, so adopting it here
would mean re-supplying the whole keyboard path by hand."*

That is the real argument for owning it. A package can carry those obligations
once, with tests; a convention cannot.

### What was weighed originally (2026-07-30)

| Library | Verdict |
|---|---|
| **solid-dnd** | Chosen at the time. Native Solid, sortable-list primitives + collision detection. Measured main-chunk cost **+13.1 KiB raw / +4.3 KiB gzip**. |
| [neodrag](https://github.com/PuruVJ/neodrag) | Can't do the job. A free-positioning *draggable* — no droppables, no collision detection, no reorder logic. |
| [dnd-kit](https://github.com/clauderic/dnd-kit) | Works (shipped briefly), but React-only adapters meant maintaining our own Solid adapter, and at ~105 kB it pushed the organiser's main chunk past Vite's 500 kB warning. |

`@shared/sortable` is smaller than all three: it implements exactly the surface
this monorepo uses and nothing else. Measured at the swap (2026-08-21), the
organiser's main chunk went **234,520 → 228,119 B raw** (−6,401; −2,164 gzip)
and `cire/invites` total JS **243,303 → 229,580 B** (−13,723), so the change
roughly recovers what solid-dnd cost. Note the older figures this page used to
quote (474,925 → 488,348 B) described a chunk layout that no longer exists.

## The primitives

The API deliberately mirrors what it replaced, so the migration was an import
swap and the existing 18 reorder tests stayed a true regression net.

```tsx
<DragDropProvider {...list.dragHandlers} collisionDetector={closestCenter}>
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
<li ref={sortable.ref} style={maybeTransformStyle(sortable.transform())}>
  <button {...sortable.dragActivators} {...item.gripProps()}>⠿</button>
</li>
```

### One difference from solid-dnd: accessors, not store properties

`transform`, `isActiveDraggable` and the provider's `active` are **accessors** —
call them. solid-dnd exposed store properties, so the migration needed three
call-site changes in `EventsEditor`. Getting this wrong is silent: passing
`sortable.transform` uncalled hands `maybeTransformStyle` a truthy function and
paints `translate3d(undefinedpx, undefinedpx, 0)`, so the row simply never moves
under the pointer while every drop-semantics test stays green. `tsc` catches it;
a package test pins the painted offset as well.

### `ref` + `dragActivators`, not a whole-row directive

Registering the node **and** attaching the activators **and** applying the
transform to the same element makes the whole row the drag affordance, which
swallows text selection and the row's own buttons.

For a **handle**, put `sortable.ref` on the row and spread
`sortable.dragActivators` onto the handle. The catch: `ref` registers the node
*without* applying the transform, so the row must apply
`maybeTransformStyle(sortable.transform())` itself. `maybeTransformStyle` returns
`{}` when there is no transform rather than an identity one — writing
`translate(0,0)` anyway would make every row a containing block and a stacking
context for its own descendants, permanently, for a no-op.

Spread `dragActivators` **before** `gripProps()` — later props win in Solid's
spread, and `gripProps` is what carries the keyboard handler, the label and the
ref.

### Multi-container

Every item registers with the `SortableProvider` it sits under, identified by a
`symbol`. Collision detection only ever considers items sharing the dragged
item's group, so N lists on a page are N independent sortables and one
`DragDropProvider` can wrap them all.

Deliberately **not** cross-container: `ChecklistView` and `BudgetView` reorder
*within* a bucket or category and POST `{timeframeBucket, orderedIds}` /
`{category, orderedIds}`. Dragging a task from "3 months out" to "1 month out"
would be a re-bucketing — a semantic change — not a re-order. A package test
pins that an item can never land in a sibling list.

## Accessibility — this is the part to not break

`createSortableList` (`@shared/sortable/list`) owns the whole keyboard and
screen-reader path. It used to live in `EventsEditor`. Five obligations, none
optional, each with a failure mode that is silent rather than obvious — which is
exactly why they belong in a package:

1. **The grip is a real `<button>`** — tabbable, owning an `onKeyDown` that moves
   the row on **Arrow Up / Arrow Down**, with `preventDefault()` *before* the
   bounds check, so a focused grip owns the arrows unconditionally rather than
   sometimes moving the row and sometimes scrolling the page out from under it.
2. **Arrow keys alone are NOT enough, and this is the subtle one.** NVDA and JAWS
   run in browse mode by default and consume unmodified arrow keys for their own
   virtual cursor, forwarding them to a plain `<button>` only in focus mode,
   which buttons don't trigger. A screen-reader user would read the hint, press
   the arrows, and get nothing. So each row also renders **`sr-only` "Move X up"
   / "Move X down" buttons**, activated by Enter/Space — the one keystroke class
   browse mode reliably forwards, and precisely what the removed ▲/▼ pair used.
   They are `focus:not-sr-only` so a sighted keyboard user never lands on an
   invisible control (WCAG 2.4.7), and `disabled` at the list ends so AT reports
   the boundary instead of the user pressing into nothing.
3. **Focus is restored explicitly** after a keyboard move. `<For>` is keyed, so
   the row's node is *moved* rather than re-created — but a DOM move is a
   remove-then-insert and focus does not reliably survive it. Without the
   explicit `.focus()`, one keypress moves the row and then focus is on `<body>`,
   so the row can't be walked further.
4. **Every move is announced** through a polite `role="status"` live region
   ("Ceremony moved to position 2 of 3"), and each grip's `aria-label` carries its
   current position with an `aria-describedby` hint pointing at the shared
   instructions. The announcement **clears before it sets** — a live region only
   speaks when its text changes, and walking one row down the list repeatedly
   produces the same sentence every time, so setting it straight would make the
   second press silent. `clearAnnouncement()` is for undo/discard, which rewind
   the order without going through a move: cleared rather than re-announced,
   since an undo may have reverted a field edit instead.
5. **Auto-repeat is ignored** (`if (event.repeat) return`). One press, one move.
   Repeat fires ~30×/s and a consumer's `onMove` is typically a draft checkpoint
   plus a full revalidation, so a held key would both stall the list and burn an
   undo stack in seconds.

**The hint id is generated** with `createUniqueId()`, not hardcoded. It used to
be `id="reorder-hint"`, which was fine while exactly one list had dragging and
collides the moment a second one appears.

Also required, and the consumer's job because they are styling: `touch-none`
(CSS `touch-action: none`) on the handle, or the browser scrolls instead of
handing the gesture over; and enough padding to clear the WCAG 2.5.8 24 px
minimum target (`px-1 py-2` on a glyph this small).

### What stays with the consumer

Haptics. The package reports drag **phases** (`pickup`, `step`, `commit`) through
`onPhase`; what they feel like is the host portal's vocabulary
(`cire/host/src/lib/haptics.ts`), not the package's. `onDragOver` reports only a
*change* of slot, so a consumer ticking per phase buzzes once per row crossed
rather than continuously.

### Geometry is measured once, at drag start

`startDrag` snapshots every row's rect and the stride, and the whole gesture
runs against that snapshot. Layout cannot change during a drag except for the
transforms this package writes — and those are exactly what must be excluded.

Measuring live got it wrong twice over, and both were found by review rather
than by any test:

- **The stride was polluted.** It is read from the first adjacent pair, and a
  live `getBoundingClientRect()` includes the dragged row's own transform. Drag
  row 0 down by exactly one row height in one motion and the stride computes to
  **zero** — at which point `computeDisplacement` bails and shift-aside silently
  stops. Dragging gradually was merely wrong rather than dead: a 68 px stride
  measured as 62 px.
- **The detector chased its own output**, seeing displaced rows in the slots
  they were moving *to* rather than the ones they belonged to.

It is also what keeps the cost flat. `RegistryView` is a documented adopter at
up to 500 rows; measuring per pointer event there is ~30–60k
`getBoundingClientRect()` per second, each behind a forced style flush because
the package writes a transform immediately before reading. The snapshot makes
that O(1) arithmetic. dnd-kit and solid-dnd both measure at drag start too.

### The gesture owns its listeners

`startDrag` attaches `pointermove`/`pointerup`/`pointercancel` to `document`,
and three things make sure they come off again:

- **Pointer capture.** Without it a drag released outside the window never gets
  its `pointerup`: the row stays stuck to a button-up pointer, and the user's
  next click anywhere commits a reorder they never made.
- **A `pointerId` guard**, so a second touch cannot drive or end the first
  finger's gesture.
- **`onCleanup` in `DragDropProvider`**, so an unmount mid-drag tears the
  listeners down rather than leaving them firing into a disposed scope.

## Testing drag in happy-dom

happy-dom does no layout — every `getBoundingClientRect()` is zeroes, so
`closestCenter` sees every row's centre at (0,0) and picks a collision
arbitrarily. **The stub must also add each row's own `translate3d` offset**, the
way a real browser's rect does: the first cut ignored transforms, which made the
whole stride-pollution class above structurally invisible to the fast tier. `EventsEditor.reorder.test.tsx` and the package's own tests work
around this by stubbing `Element.prototype.getBoundingClientRect` to return
stacked rects derived from each row's *current* DOM position (so they stay
correct after a reorder), then dispatching `pointerdown` → `pointermove` × 2 →
`pointerup`. The first move gets past the sensor's activation threshold.

Two behaviours that threshold pins, and that the package tests directly: a press
with no movement leaves the order untouched (a handle is usually also a button —
without a threshold every click on it would start and end a drag), and a movement
below `ACTIVATION_DISTANCE` does not activate.

Keyboard tests need none of that and are fully deterministic — the cheaper
regression net of the two. One trap: Solid delegates `onKeyDown` to the document
root, so a hand-constructed `KeyboardEvent` needs `bubbles: true` or it never
reaches the handler.

What this still can't cover: drag *feel*, the shift/settle animation, and the
grip's hover/focus styling. Those need a real browser and a pair of eyes —
`bun run dev:lab` → **shared/sortable**, which benches exactly those three plus
the multi-container isolation. See [[component-lab]].

The shift-aside is why that bench exists. It shipped broken: `transform` returned
`null` for every non-dragged row, so the rows between the dragged one and its
target never opened a gap and `EventsEditor`'s "animate the OTHER rows shifting
aside" styling animated nothing — with every drop-semantics test green. The
displacement is now computed from the `SortableProvider`'s `ids` and a stride
**measured** from the first adjacent pair of rows (the gap lives in the
consumer's CSS, so a package that assumed it would open a hole of the wrong
size), and three tests pin it. A bench would have caught it in a second.

## Scope + open follow-ups

Current adopters:

- **Schedule → Edit** (`EventsEditor`) — see `[[cire-guest-event-editor]]` E7.

Still on arrow buttons, and now cheap to convert — the keyboard path comes free,
so each is a UX decision rather than an accessibility project:

- `ChecklistView` — tasks within a lead-time bucket, persisted via `tasks/reorder`.
- `BudgetView` — items within a category, via `budget/items/reorder`.
- `RegistryView` — a single flat list of up to 500 rows, via `registry/items/reorder`.
  Note REG-P-W1: it rewrites only the rows whose position actually changed, because
  a blanket `{ ...it }` tears down every row and loses an open inline editor's caret.
  Any drag adoption must preserve that.
