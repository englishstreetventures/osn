---
title: Cire host portal layout system
tags: [architecture, web, organiser, cire]
related:
  - "[[index]]"
  - "[[cire-invite-builder]]"
  - "[[cire-organiser]]"
last-reviewed: 2026-09-01
---
# Host Portal Layout System

How `cire/host` decides how wide things are. One page because the answer
used to be spread across a dozen components with three different mental models,
and because getting it wrong is visible on every screen the portal is used on.

Two rules cover almost every case:

1. **A container query when the layout changes *shape*** — rail or sheet, one
   column or two, agenda above the stats or beside them.
2. **An intrinsic value when it only needs to *scale*** — page gutters, card
   counts, field counts.

Neither is a viewport query. The portal has had container queries in its shell
since the 2026-07-22 redesign; what this page adds is the second half — the
intrinsic layer — and the removal of the fixed page cap that made most of the
wide-layout code unreachable.

## The frame: `page-frame`

`cire/host/src/styles/global.css` defines it. Every top-level surface wears
it: the masthead, `<main>`, the login card, and the two portalled save bars in
the guests/events editors (so a `fixed` bar's contents line up with the page
behind it).

```css
@utility page-frame {
  width: 100%;
  max-width: var(--page-max, 100rem);
  margin-inline: auto;
  padding-inline: clamp(1.25rem, 3cqi, 3.5rem);
}
```

- **`max-width: 100rem`** replaced a hard `max-w-[1100px]`. On a 2560px monitor
  the old cap threw away more than half the screen *and* — more importantly —
  kept the panel below every wide-layout threshold the components already
  declared: the invite builder's `@4xl/builder` side-by-side preview could never
  fire, because the panel physically could not reach 56rem.
- **Gutters are `cqi`-based**, so they scale continuously instead of stepping at
  a breakpoint. They resolve against `@container/frame` on the document wrapper;
  outside it (the portalled save bars) `cqi` falls back to the viewport, which is
  the right reference for a viewport-anchored element anyway.
- **`--page-max` is the knob.** The login page sets `[--page-max:30rem]` — a
  sign-in card has one job and shouldn't grow with the screen.
- **It behaves differently inside a `<Portal>`.** The guests/events editors' save
  bars are `position: fixed` inside a Portal (they must be, because an ancestor
  panel declares `container-type`, which would otherwise become their containing
  block). Appended to `document.body`, they have no query-container ancestor, so
  `3cqi` falls back to the small-viewport size. That is the right reference for a
  viewport-anchored bar, but it tracks a different box from the in-page frame —
  they can disagree by a classic scrollbar's width. Accepted; do not assume
  `page-frame` is context-free.

100rem is a judgement, not a law: far enough that a widescreen gets the rail, a
wide panel and the builder's live preview at once; short enough that a guest
table row is still scannable in one sweep.

## Intrinsic card grids: `auto-grid`

```css
@utility auto-grid {
  display: grid;
  gap: var(--auto-grid-gap, 1rem);
  grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--auto-grid-min, 18rem)), 1fr));
}
```

Used as `class="auto-grid [--auto-grid-min:22rem]"`. It fits as many whole
columns of at least the minimum as there is room for, then shares the remainder.

Why not more container-query steps? Because a `grid-cols-2 @3xl:grid-cols-3`
ladder encodes today's widest screen and has to be extended by hand for the next
one — and it measures the *container*, which is often not the box the cards are
actually in (the invite builder's field grids were querying the builder while
sitting in the narrower form column). An intrinsic grid is right in both places
with no ladder.

Three constraints:

- `min(100%, …)` keeps the one-column case from overflowing a container narrower
  than the minimum.
- **Never `col-span-*` a child.** Under `auto-fit`, a span wider than the resolved
  column count creates an implicit column and breaks the row. When one cell must
  be wider, use an explicit container-query grid (Overview does).
- **The track minimum must stay a fixed length.** `minmax(min(100%, <length>),
  1fr)` never asks a child for its intrinsic contribution, and that is what makes
  it safe to put `container-type: inline-size` on an `auto-grid` child — which the
  event cards do. Swapping the minimum for `min-content` / `max-content` / `auto`
  would ask an inline-size container for a contribution it cannot give and
  collapse every such track to zero width. Invisible from the CSS alone, so it is
  also asserted in `styles/layout-utilities.test.ts`.

Both utility names, and every `--page-max` / `--auto-grid-*` override, are
guarded by `cire/host/tests/styles/layout-utilities.test.ts`. Tailwind ignores
a class it doesn't recognise and CSS ignores a custom property nobody reads, so a
rename or a typo (`[--autogrid-min:20rem]`) produces no build error, no lint
error and no component-test failure — just every grid collapsing to one column.
That guard is the one CSS-layer risk here that *is* mechanically checkable.

### Current minimums

| Surface | `--auto-grid-min` | Why |
|---|---|---|
| Overview stat cards | 15rem | A number plus a label; small cards read fine. |
| Wedding list | 20rem | Slug + display name + CTA line. |
| Checklist buckets | 22rem | A task row with a checkbox and reorder arrows. |
| Budget categories | 32rem | Name + three money cells + payments toggle — below this the row wraps and stops reading as a row. |
| Event cards | 26rem | Header, details grid, palette chips, links. |
| Directory listings | 19rem | Name + category chips + a line of meta. |
| Settings fields, import steps | 17rem | A single input or a short paragraph. |
| Builder field grids | 15rem | A labelled `<select>`. |

## Named containers

| Container | Declared on | Queried for |
|---|---|---|
| `frame` | document wrapper (`index.astro`) | masthead/main vertical rhythm |
| `page` | `OrganiserApp`'s root | views outside the module shell |
| `shell` | `ModuleShell`'s root | rail vs sheet, shell gap, rail width |
| `panel` | the module panel | per-module layout switches |
| `builder` | the invite-builder card | form-only vs form + preview pane |
| `card` | an event card | the card's own details grid |
| `enquiries` | the enquiries view | inbox-or-thread vs inbox-and-thread |

A container cannot be queried by the element that declares it — the query always
sits on a descendant. `card` and `enquiries` are new; both exist because a
component was previously reading a container it did not live in.

## Layout switches worth knowing

- **Module rail** (`ModuleSidebar`) — `@2xl/shell` swaps the sheet trigger for the
  rail, and the rail is `sticky top-6 self-start` from the same threshold. Without
  `self-start` the flex row stretches it to the panel's height and there is
  nothing left to slide against. Widening to `w-56` at `@5xl/shell`.
- **Overview** (`Overview`) — `@4xl/panel` turns the stacked agenda + cards into
  `minmax(20rem,26rem) minmax(0,1fr)`: the agenda takes a fixed-measure left
  column, the stat cards fill the rest. A six-row dated list does not want 1300px.
- **Invite builder** (`invite/InviteBuilder`) — `@4xl/builder` puts the composed
  `PreviewPane` beside the form (sticky, `w-80`, `w-96` from `@6xl/builder`). This
  code predates this pass; it was simply unreachable under the old page cap.

  The builder itself shows **one section at a time** (2026-07-30) — a real tab
  switcher (`activeSection` signal + `role="tablist"`/`role="tab"` pills), not
  the old vertical stack of all eight `SectionCard`s with a `scrollIntoView`
  jump nav bolted on top. Inactive cards stay MOUNTED (`SectionCard`'s `hidden`
  prop sets the native `hidden` attribute) rather than unmounting — draft
  state, dirty tracking and the inline previews are builder-wide, and
  unmounting would have thrown all of that away on every tab switch for no
  reason. Below `@4xl/builder`, where the sticky pane can't show, a "Preview"
  button next to the tabs opens the same `PreviewPane` in `PreviewModal.tsx`
  (a `<Portal>` dialog) instead — one composed-preview markup source, two
  presentations, fed by five small per-slot prop helpers (`heroPreviewProps`,
  `storyPreviewProps`, …) called at each consumer's own JSX prop position, NOT
  spread from one pre-built object — see `[[cire-invite-builder]]` for why the
  spread version silently broke live updates.

  It is also the one place that **measures instead of only querying**. The two
  preview layers — five inline per-section previews, and the composed pane — used
  to both be mounted at every width with the container query hiding one, so the
  idle layer still took every token write on every keystroke and colour-drag
  frame (perf **P-I1**). The builder now observes its own `@container/builder`
  element and mounts one layer or the other:

  - A `ResizeObserver`'s `contentRect` **is** the content box a container query
    evaluates, so the mount crossover cannot drift from the CSS one.
  - `WIDE_BUILDER_REM` is the threshold in JS, because container queries have no
    `matchMedia` equivalent. It is compared against the root font size, not a
    hard-coded 16px.
  - The state is tri-state, and `unknown` mounts **both**: with no
    `ResizeObserver`, before the first measurement, or while the builder sits in a
    `display: none` ancestor, we don't know which side we're on, and unmounting an
    unmeasurable layer could leave an organiser with no preview at all. The
    container-query classes stay on both layers as the visual authority, so they
    never both show in a browser — including during the first frame.
  - Cost of the trade: crossing the threshold re-creates the newly mounted layer,
    so its desktop/phone toggle returns to desktop.

  Reach for this pattern only when mounting is what's expensive. Hiding with a
  container query remains the default — it needs no JS and no threshold in two
  places.
- **Enquiries** (`EnquiriesView`) — `@3xl/enquiries` shows the inbox and the
  thread together. The inbox stays **mounted** while a thread is open and is
  hidden with `@max-3xl/enquiries:hidden`, so widening the panel mid-conversation
  reveals the list without a refetch, and `display: none` keeps its buttons out of
  the tab order when narrow. `EnquiryInbox` takes `selectedId` to mark the open
  row (`aria-current`), which only matters in the side-by-side case.

  **This one is not just CSS, and it cost three bugs.** The old inbox-or-thread
  `Show` pair was doing load-bearing work nobody had written down: it unmounted
  the thread on every navigation. Read the three notes below before touching it.

  1. The thread's `Show` is **`keyed` on the open enquiry's id**. Side by side you
     can click row B while replying to row A, which keeps an unkeyed `Show`
     truthy — Solid then reuses the same `EnquiryThread`, and its local `draft`
     signal hands vendor A's half-typed reply to vendor B.
  2. Solid's `Show` only *calls* a children function whose **arity is ≥ 1** (it
     tests `children.length`). A zero-argument `{() => …}` is returned as a plain
     child, so `keyed` silently does nothing — which is exactly how the first fix
     failed. The children function consumes the keyed id.
  3. `messages` is a `createResource` keyed on the selection, and reading a
     resource mid-refetch yields the **previous** value. The resolved value
     therefore carries its own `enquiryId`, and `messagesFor(id)` refuses
     messages that aren't the named enquiry's — otherwise A's correspondence
     renders under B's name for a round-trip. Re-fetching the *same* enquiry
     (after sending) still matches, so the thread doesn't blank.
  4. `handleSend` refreshes the list with `setCachedEnquiries`, **not**
     `invalidateEnquiries` + `ensureEnquiriesLoaded`. Invalidation is
     `cache.delete(...)`, which mints a new signal; the always-mounted inbox
     keeps reading the orphan, so the round-trip is paid and nothing updates.
     The store-level fix for all four caches is **P-W2**, filed in `xchromo/osn-tracker`.
- **Event cards** (`EventTable`) — cards flow in an `auto-grid`; each card is its
  own `@container/card` and its details grid switches at `@md/card`.

## Testing

happy-dom does not evaluate container queries, so both surfaces of a two-surface
component are in the DOM during tests and neither is hidden. Scope queries to the
landmark you mean (the nav tests do this for the rail vs the sheet, the
checklist/budget tests for each bucket or category `<section>`) rather than
asserting on visibility. Do not assert on class strings.

The invite builder's section tabs are a different case worth knowing:
`SectionCard`'s inactive-section `hidden` attribute is a REAL DOM attribute
(not a CSS class happy-dom ignores), and `@testing-library/dom`'s `getByRole`
excludes hidden elements from the accessibility tree even in happy-dom —
`getByLabelText`/`getByText` do not. So `InviteBuilder.test.tsx` needs its
`openSection("Hero")` helper (clicks the named tab) before any `getByRole`
query against a non-default section's controls, but the many tests that only
read/type into fields via `getByLabelText` across several sections in one flow
needed no change at all.

What that leaves testable, and where it lives:

| What | Where |
|---|---|
| Utility names + custom-property wiring (the silent-collapse failure mode) | `styles/layout-utilities.test.ts` — static text, no DOM |
| DOM containment of grid siblings, and per-group reorder indices | `ChecklistView.test.tsx`, `BudgetView.test.tsx` |
| Master-detail behaviour: draft-per-enquiry, no cross-thread messages, placeholder, `aria-current` cardinality, post-reply refresh | `EnquiriesView.test.tsx`, `EnquiryInbox.test.tsx` |
| Which preview layer mounts, and that its crossover matches `@4xl/builder` | `InviteBuilder.test.tsx` — with a stub `ResizeObserver` reporting a fixed content-box width, since happy-dom runs no layout |
| The container queries themselves | Nothing. A browser-driven visual check is the only real test, and this package has no such harness. |
