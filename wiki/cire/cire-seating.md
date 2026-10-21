---
title: Cire seating chart
tags: [systems, platform, phase4, seating, cire]
related:
  - "[[index]]"
  - "[[cire-platform-plan]]"
  - "[[drag-and-drop]]"
  - "[[cire-entitlements]]"
  - "[[cire-host-portal-layout]]"
  - "[[cire-guest-event-editor]]"
last-reviewed: 2026-10-21
---
# Seating chart

Tables at one event, and which guest sits at which table. Phase 4 of
[[cire-platform-plan]] §7. A host sets out tables for an event, seats guests by
dragging them or by choosing a table from a menu, sees who declined, said
maybe, has not replied or was withdrawn, prints the chart and downloads it for
the venue.

Seating is a **Gold** module ([[cire-entitlements]]): the reads and writes sit
behind `weddingTier(db, "gold")`, and the portal fades the nav row below Gold.
An owner's `seating.csv` and its row count are not tier-gated, so a wedding
moved below Gold takes its chart back from the locked card.

## Tables

Migration `0089_seating.sql` adds two tables and one index on `events`. No
table is rebuilt.

### `seating_tables`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `stb_<uuid>` |
| `wedding_id` | `text` NOT NULL | the event's wedding |
| `event_id` | `text` NOT NULL | |
| `name` | `text` NOT NULL | 1–80 characters, trimmed |
| `capacity` | `integer` NOT NULL | 1–100; the API refuses a seat past it |
| `sort_order` | `integer` NOT NULL | default 0; order of the event's tables |
| `created_at`, `updated_at` | `integer` NOT NULL | |

- **`(event_id, wedding_id)` → `events(id, wedding_id)` ON DELETE CASCADE.** A
  table's wedding is its event's wedding, by the database. The parent key is
  the unique index `events_id_wedding_uniq (id, wedding_id)` — unique already,
  since `id` is, but SQLite accepts a composite foreign key only against a
  unique index on exactly those columns. A rebuild of `events` that drops it
  makes every seating-table write and every event delete fail with "foreign key
  mismatch"; a `DROP TABLE events` cascades into both seating tables, so a
  rebuild needs the `__keep_*` idiom for them too.
- **`seating_tables_event_id_uniq (event_id, id)`** — the parent key of the
  seats' foreign key, the probe an event delete cascades through, and the index
  an event's tables are read by.
- An event holds at most **100** tables (`MAX_TABLES_PER_EVENT`, checked in the
  INSERT that writes one).

### `seating_assignments`

| Column | Type | Notes |
|---|---|---|
| `table_id` | `text` NOT NULL | |
| `event_id` | `text` NOT NULL | the table's event, repeated |
| `guest_id` | `text` NOT NULL | |
| `created_at` | `integer` NOT NULL | |

- **PK `(table_id, guest_id)`.**
- **Unique `(event_id, guest_id)` — a guest sits at no more than one table per
  event.** The database refuses a second seat whatever writes it: `UNIQUE
  constraint failed: seating_assignments.event_id, seating_assignments.guest_id`.
- **`(table_id, event_id)` → `seating_tables(id, event_id)` ON DELETE CASCADE**
  keeps the repeated `event_id` equal to the table's; deleting a table unseats
  its guests.
- **`(guest_id, event_id)` → `guest_events(guest_id, event_id)` ON DELETE
  CASCADE** admits only a guest invited to the event, and takes the seat away
  with the invitation — an editor save, an import, a guest or event delete, a
  household removing its plus-one, the retention sweep.

No index on either table leads with `wedding_id`, and none on the seats with
`guest_id`. Every statement reaches a table by its `id` or its event and a seat
by its table or its event, scoping to a wedding through `events`.
`cire/api/tests/db/seating-index.test.ts` runs every seating statement and
fails on a full scan of either table.

### Who a chart holds

The guests invited to the event (`guest_events`) from the wedding's guest
households:

- **The host-preview household** (`families.kind = 'host'`) never appears, and
  the API refuses to seat it (404 `guest_not_found`).
- **A withdrawn household** (`families.deactivated_at` set) cannot be seated or
  moved (409 `household_withdrawn`). Its guests appear only while they still
  hold a seat, marked "Invite withdrawn", so a host can clear the seat.
- **An event with no stated end** (`end_at = ""`) seats like any other: nothing
  here reads an end time.

## API

`cire/api/src/routes/seating.ts`, mounted in `createApp` past the `AnyElysia`
widening. Two sibling instances, so the read gate and the write gate never
apply to each other's routes.

| Method | Path under `/api/organiser/weddings/:weddingId` | Gate |
|---|---|---|
| GET | `/seating/events/:eventId` | `weddingMember` + Gold |
| POST | `/seating/events/:eventId/tables` `{name, capacity}` | `weddingEditor` + Gold |
| PATCH | `/seating/events/:eventId/tables/reorder` `{orderedIds}` | `weddingEditor` + Gold |
| PATCH | `/seating/tables/:tableId` `{name?, capacity?}` | `weddingEditor` + Gold |
| DELETE | `/seating/tables/:tableId` | `weddingEditor` + Gold |
| PUT | `/seating/events/:eventId/guests/:guestId` `{tableId \| null}` | `weddingEditor` + Gold |
| GET | `/seating.csv` | `weddingOwner` + the shared export limiter; no tier gate |

Refusals: 404 `event_not_found`, `table_not_found`, `guest_not_found`; 409
`table_full`, `table_limit`, `capacity_below_seated`, `household_withdrawn`;
400 for a malformed body. The chart read is `Cache-Control: no-store`.

- **The chart** is one round trip: the event (id and name), its tables and its
  guests (name, reply, withdrawn, seat — what the screen and the print sheet
  show, and no more) as three SELECTs in one batch, the guests capped at 1,000
  (`MAX_CHART_GUESTS`; the tier cap keeps every real event under it).
- **A seat or a move** is one batch, one transaction on D1: a conditional
  UPDATE that moves an existing seat, a conditional INSERT that seats a guest
  with none, and the seat after. Each write carries every rule in its own
  WHERE — the table is this event's, it has room, the household is active — so
  a refused move changes nothing and the guest keeps the seat they had, and two
  requests for a table's last place cannot both land. The writes' `RETURNING`
  rows say whether it was a seat or a move; only a refusal reads again, to say
  why. An unseat is the event check and a `DELETE … RETURNING`.
- **Reorder** is one statement: each table reads its new place from one bound
  JSON object keyed by id, and only a table whose place changed is written, so
  a keyboard step writes the two tables it swaps and the order lands whole.
  Ids are word characters and hyphens (the schema refuses anything else), which
  keeps them safe inside the JSON path.
- **`seating.csv`** lives with the other CSV exports in
  `createOrganiserExportRoutes`: every seated guest at every event, by event,
  table, household and guest order, columns `Event, Table, Capacity, Guest,
  Household, RSVP`. No dietary column. Capped at 4,000 rows
  (`MAX_SEATING_EXPORT_ROWS`), read as one past the ceiling and logged when cut;
  `GET …/module-rows` counts `seats` for the locked card.

### What other writers do to seats

- **Import and editor saves** go through `diffAgainstDb`, which warns how many
  seats and tables a change clears ("This change clears 2 seats and removes 1
  table from the seating chart. Reverting it does not bring them back."). The
  preview reads the seat count beside the RSVP warning's read, at the same
  time; the apply and every revert pass `warnings: false` and read neither,
  since nothing they run reads the plan's warnings. The
  before-image a revert restores holds no seating, and the revert confirm says
  so. An event removal deletes the event's seats and tables itself, before its
  invitations, in two statements for all removed events.
- **The retention sweep** deletes every seat at the swept weddings' events
  itself, before the invitations, and keeps the tables with the rest of the
  wedding's shell.

## Portal

`cire/host/src/components/SeatingView.tsx`, loaded on demand from
`ModuleShell` (a Gold module's bytes are not paid by those who cannot open it).
One event at a time, chosen from the wedding's events.

- **Two ways to seat, move or unseat a guest**, each complete: drag the row onto
  a table (or back onto "Not seated"), or choose from the row's menu (a Kobalte
  `DropdownMenu` of tables, full tables disabled). The menu is the keyboard,
  screen-reader and phone path — a touch drag cannot scroll the page
  mid-gesture. The drag handle is pointer only and outside the tab order. Drop
  zones are `@shared/sortable`'s ([[drag-and-drop#Drop zones]]). A drop on a full
  table is refused in the view, as the menu refuses it, without a request.
  Each row holds a plain button that looks like the menu's trigger until the
  menu is first used; the event that opened it is then replayed on Kobalte's
  trigger, so a chart of 1,000 guests builds no menu state nobody opens. A
  click no press came before (a screen reader's, voice control's) opens the
  menu as a tap's click does, before and after its first use.
- **A status line** says and shows every seat, move, refusal and table change.
  It is the live region.
- **Badges** in words: Declined, Maybe, No reply, Invite withdrawn.
- **Arrange tables** is a uniform one-line-per-table list ordered with
  `createSortableList`, where the package's keyboard path applies unchanged.
  Table cards themselves vary in height, which the list's stride measurement
  does not handle. The list and the cards iterate table ids and look each table
  up through `sameButOrder`, so a re-order moves a card rather than rebuilding
  it, and a rename form left open stays open.
- **Print** renders a sheet into `<body>` and marks `<html>` from `beforeprint`
  to `afterprint`, so no hidden copy of the chart is kept current on screen; the
  stylesheet then prints the sheet alone (`cire/host/DESIGN.md` §Print sheet).
  The Print button and the browser's own print both fire the pair.
- State is the view's own, dropped with it: no wedding cache store holds the
  chart.

## Extending it

- **Alternative layouts per event** (englishstreetventures/osn#1391, one selected
  plan, uniqueness per event and plan) need no rebuild of `seating_tables`: a
  `seating_plans` table, a nullable `plan_id` on both tables backfilled to one
  selected plan per event (SQLite's ADD COLUMN takes a REFERENCES clause when
  the default is NULL), and the `(event_id, guest_id)` unique index swapped for
  `(plan_id, guest_id)`. Tying a seat's plan to its table's plan needs a
  composite foreign key that SQLite cannot add in place: a trigger, or a
  copy-and-swap of `seating_assignments`, which is safe because nothing
  references it. No row is lost either way.
- **A guest finding their seat** (englishstreetventures/osn#1412) is a read: the
  household's guest ids → `seating_assignments` by `(event_id, guest_id)` →
  `seating_tables.name`.

## Observability

- Spans: `cire.seating.chart`, `.createTable`, `.updateTable`, `.removeTable`,
  `.reorderTables`, `.seat`, `.loss`, `.exportCsv`.
- Counters (`cire/api/src/metrics.ts`, never an id): `cire.seating.table.write`
  {`action`: create, update, remove, reorder}; `cire.seating.seat.write`
  {`action`: seat, move, unseat}; `cire.seating.write.refused` {`reason`:
  table_full, table_limit, capacity_below_seated, household_withdrawn}.
- A request defect logs `seating request failed` with the wedding id and the
  operation, never a guest name.

## Tests

| What | Where |
|---|---|
| Gates, refusals, the database's one-seat rule, who a chart holds, the CSV, the metrics, and what a failure answers and logs | `cire/api/tests/routes/seating.test.ts` |
| The same rules and the seat batch on real D1, a race for the last place | `cire/api/tests/db/d1-integration.test.ts` (seating) |
| No full scan of either table | `cire/api/tests/db/seating-index.test.ts` |
| The CSV ceiling | `cire/api/tests/services/seating-export.test.ts` |
| Import warning and explicit deletes | `cire/api/tests/services/import-seating.test.ts` |
| Retention deletes seats without the cascade | `cire/api/tests/services/retention.test.ts` |
| The view's controls against a fake API | `cire/host/tests/components/SeatingView.test.tsx` |
| Real pointer drag, print, phone layout, screenshots | `cire/host/tests/components/SeatingView.browser.test.tsx` |

The organiser portal has no end-to-end flow yet (englishstreetventures/osn#1591);
the browser tier writes the screenshots a reviewer checks, to
`cire/host/.vitest/attachments/seating/`.
