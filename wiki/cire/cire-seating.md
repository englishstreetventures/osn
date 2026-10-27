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
  - "[[production-deploy]]"
last-reviewed: 2026-10-26
---
# Seating chart

Tables at one event, and which guest sits at which table. Phase 4 of
[[cire-platform-plan]] §7. A host sets out tables for an event, seats guests by
dragging them or by choosing a table from a menu, sees who declined, said
maybe, has not replied or was withdrawn, prints the chart and downloads it for
the venue.

An event's chart comes in **seating plans**: versions of it, each with its own
tables and seats, one of them **in use** — the plan the venue file prints. The
API makes, copies, renames, deletes and switches plans, and editing one plan
changes no other; the portal shows and edits each event's plan in use. The
portal's plan controls are englishstreetventures/osn#1391.

Seating is a **Gold** module ([[cire-entitlements]]): the reads and writes sit
behind `weddingTier(db, "gold")`, and the portal fades the nav row below Gold.
An owner's `seating.csv` and its row count are not tier-gated, so a wedding
moved below Gold takes its chart back from the locked card; its other plans
stay stored but cannot be opened until it is back on Gold.

## Tables

Migration `0089_seating.sql` adds the tables and seats and one index on
`events`; `20261026040620_seating_plans.sql` adds the plans. No table that
others reference is rebuilt.

### `seating_plans`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `spl_<uuid>`; `spl_` and 32 hex digits when SQL mints it (the migration, a trigger) |
| `wedding_id` | `text` NOT NULL | the event's wedding |
| `event_id` | `text` NOT NULL | |
| `name` | `text` NOT NULL | 1–80 characters, trimmed |
| `selected` | `integer` NOT NULL | boolean, default 0; the plan in use |
| `created_at`, `updated_at` | `integer` NOT NULL | |

- **`(event_id, wedding_id)` → `events(id, wedding_id)` ON DELETE CASCADE.**
- **`seating_plans_event_id_uniq (event_id, id)`** — the probe an event delete
  cascades through, and the index an event's plans are read by.
- **`seating_plans_one_selected_per_event (event_id) WHERE selected = 1`** — at
  most one plan in use per event, whatever writes it. "At least one" is the
  API's: an event's first plan is made in use, the plan in use cannot be
  deleted, and a switch clears the old one only in the batch that sets the new.
- An event holds at most **5** plans (`MAX_PLANS_PER_EVENT`, checked in the
  INSERT that writes one).

### `seating_tables`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | `stb_<uuid>` |
| `wedding_id` | `text` NOT NULL | the event's wedding |
| `event_id` | `text` NOT NULL | the plan's event |
| `plan_id` | `text` | → `seating_plans(id)` ON DELETE CASCADE; see below |
| `name` | `text` NOT NULL | 1–80 characters, trimmed |
| `capacity` | `integer` NOT NULL | 1–100; the API refuses a seat past it |
| `sort_order` | `integer` NOT NULL | default 0; order of the plan's tables |
| `created_at`, `updated_at` | `integer` NOT NULL | |

- **`(event_id, wedding_id)` → `events(id, wedding_id)` ON DELETE CASCADE.** A
  table's wedding is its event's wedding, by the database. The parent key is
  the unique index `events_id_wedding_uniq (id, wedding_id)` — unique already,
  since `id` is, but SQLite accepts a composite foreign key only against a
  unique index on exactly those columns. A rebuild of `events` that drops it
  makes every seating write and every event delete fail with "foreign key
  mismatch"; a `DROP TABLE events` cascades into all three seating tables, so a
  rebuild needs the `__keep_*` idiom for them too.
- **`plan_id` is nullable** only because SQLite adds a column with a foreign
  key no other way, and the table cannot be rebuilt while its seats cascade
  from it. The API always writes it: a new table takes its plan's event and
  wedding in the same `INSERT … SELECT`, so the two agree. A row written
  without one is put into its event's plan in use by the trigger
  `seating_tables_adopt_plan`, which makes that plan, as "Plan 1", when the
  event has none.
- **A table's plan is a plan of its own event and wedding**, by the triggers
  `seating_tables_plan_at_event` (on INSERT) and
  `seating_tables_plan_at_event_update` (on an UPDATE of `plan_id`, `event_id`
  or `wedding_id`), which abort with "seating table plan is not a plan of its
  event". A column added by ADD COLUMN cannot carry the composite foreign key
  that would say it.
- **`seating_tables_event_id_uniq (event_id, id)`** — the parent key of the
  seats' `(table_id, event_id)` foreign key, and the probe an event delete
  cascades through.
- **`seating_tables_plan_id_uniq (plan_id, id)`** — the parent key of the
  seats' `(table_id, plan_id)` foreign key, the probe a plan delete cascades
  through, and the index a plan's tables are read by.
- A plan holds at most **100** tables (`MAX_TABLES_PER_PLAN`, checked in the
  INSERT that writes one).

### `seating_assignments`

| Column | Type | Notes |
|---|---|---|
| `table_id` | `text` NOT NULL | |
| `plan_id` | `text` | the table's plan, repeated |
| `event_id` | `text` NOT NULL | the table's event, repeated |
| `guest_id` | `text` NOT NULL | |
| `created_at` | `integer` NOT NULL | |

- **PK `(table_id, guest_id)`.**
- **Unique `(plan_id, guest_id)` — a guest sits at no more than one table per
  plan**, and a plan is one event's. The database refuses a second seat
  whatever writes it: `UNIQUE constraint failed: seating_assignments.plan_id,
  seating_assignments.guest_id`. The same guest has a seat of their own in each
  plan.
- **`(table_id, event_id)` → `seating_tables(id, event_id)` and `(table_id,
  plan_id)` → `seating_tables(id, plan_id)`, both ON DELETE CASCADE**, keep the
  repeated columns equal to the table's; deleting a table unseats its guests in
  its plan.
- **`(guest_id, event_id)` → `guest_events(guest_id, event_id)` ON DELETE
  CASCADE** admits only a guest invited to the event, and takes the seat away,
  in every plan, with the invitation — an editor save, an import, a guest or
  event delete, a household removing its plus-one, the retention sweep. Its
  probe is the plain index `seating_assignments_event_guest_idx (event_id,
  guest_id)`.
- **`plan_id` is nullable** for a writer that does not name it; the trigger
  `seating_assignments_adopt_plan` copies the table's plan into the row. A
  foreign key with a NULL column is not checked, so the trigger's UPDATE is
  what the composite key and the unique index check.

### `seating_copy_budget`

| Column | Type | Notes |
|---|---|---|
| `wedding_id` | `text` NOT NULL | → `weddings(id)` ON DELETE CASCADE |
| `day` | `text` NOT NULL | `YYYY-MM-DD`, UTC |
| `copied` | `integer` NOT NULL | default 0; tables and seats copied that day |

- **PK `(day, wedding_id)`**, so the delete of earlier days reads only the rows
  it removes; **`seating_copy_budget_wedding_idx (wedding_id)`** is the probe
  the wedding purge cascades through.
- Holds no name and no guest: one count per wedding per day. A copy deletes
  every earlier day's rows, any wedding's, in its own batch.

No index on any of the three chart tables leads with `wedding_id`, and none on
the seats with `guest_id`. Every statement reaches a plan by its `id` or its event, a
table by its `id`, its plan or its event, and a seat by its table, its plan or
its event, scoping to a wedding through `events`.
`cire/api/tests/db/seating-index.test.ts` runs every seating statement and
fails on a full scan of any of them.

### Rolling back past the plans migration

`20261026040620_seating_plans.sql` runs before the new Worker serves, and a
failed smoke check brings back the Worker before it without undoing the
migration ([[production-deploy#4. Database migrations]]). That Worker names no
plan. Its tables and seats are adopted by the two adopt triggers, and on an
event with one plan it reads and writes as it always did. The portal of the
release that carries the migration is the portal before plans: it calls only
addresses both Workers serve, and makes no second plan. Only a direct call to
the new plan routes can. `cire/api/tests/db/migration-20261026040620.test.ts`
replays that Worker's statements on a migrated database.

On an event with more than one plan, the Worker before the migration reads and
writes by event alone: its chart and its venue file list every plan's tables, a
guest seated in two plans is listed twice, an unseat clears the guest's seat in
every plan, and a move of a guest seated in more than one plan fails on the
composite key. So before rolling the Worker back past the migration, check
that no event holds a second plan, and roll forward instead if one does:

```bash
cd cire/api
bunx wrangler d1 execute cire-db --env production --remote --command \
  "SELECT event_id FROM seating_plans GROUP BY event_id HAVING count(*) > 1"
```

Once the portal's plan controls ship, roll forward rather than back. The adopt
triggers go, and `plan_id` stops taking NULL, once no Worker before the
migration can serve (englishstreetventures/osn#1658).

### Who a chart holds

The guests invited to the event (`guest_events`) from the wedding's guest
households:

- **The host-preview household** (`families.kind = 'host'`) never appears, and
  the API refuses to seat it (404 `guest_not_found`).
- **A withdrawn household** (`families.deactivated_at` set) cannot be seated or
  moved (409 `household_withdrawn`). Its guests appear in a plan only while
  they still hold a seat in it, marked "Invite withdrawn", so a host can clear
  the seat.
- **An event with no stated end** (`end_at = ""`) seats like any other: nothing
  here reads an end time.
- **A reply or an invitation that changes moves no seat.** Each plan keeps the
  guest where they sat.

## API

`cire/api/src/routes/seating.ts`, mounted in `createApp`. Three sibling
instances, so the read gate, the write gate and the plan limiter never apply
to each other's routes.

| Method | Path under `/api/organiser/weddings/:weddingId` | Gate |
|---|---|---|
| GET | `/seating/events/:eventId[?plan=<planId>]` | `weddingMember` + Gold |
| POST | `/seating/events/:eventId/plans` `{name, copyFrom?}` | `weddingEditor` + Gold + the plan limiter |
| PUT | `/seating/events/:eventId/selected-plan` `{planId}` | `weddingEditor` + Gold |
| POST | `/seating/events/:eventId/tables` `{name, capacity}` | `weddingEditor` + Gold |
| PATCH | `/seating/events/:eventId/tables/reorder` `{orderedIds}` | `weddingEditor` + Gold |
| PUT | `/seating/events/:eventId/guests/:guestId` `{tableId \| null}` | `weddingEditor` + Gold |
| PATCH | `/seating/plans/:planId` `{name}` | `weddingEditor` + Gold |
| DELETE | `/seating/plans/:planId` | `weddingEditor` + Gold + the plan limiter |
| POST | `/seating/plans/:planId/tables` `{name, capacity}` | `weddingEditor` + Gold |
| PATCH | `/seating/plans/:planId/tables/reorder` `{orderedIds}` | `weddingEditor` + Gold |
| PUT | `/seating/plans/:planId/guests/:guestId` `{tableId \| null}` | `weddingEditor` + Gold |
| PATCH | `/seating/tables/:tableId` `{name?, capacity?}` | `weddingEditor` + Gold |
| DELETE | `/seating/tables/:tableId` | `weddingEditor` + Gold |
| GET | `/seating.csv` | `weddingOwner` + the shared export limiter; no tier gate |

Refusals: 404 `event_not_found`, `plan_not_found`, `table_not_found`,
`guest_not_found`; 409 `plan_limit`, `copy_budget`, `plan_selected`,
`table_full`, `table_limit`, `capacity_below_seated`, `household_withdrawn`;
429 past the plan limiter; 400 for a malformed body or `plan` query. The chart
read is `Cache-Control: no-store`.

- **The plan limiter** is per user, 10 a minute (`defaultSeatingPlanLimiter`
  in `cire/api/src/app.ts`), on making and deleting plans only: a copy writes
  a plan, up to 100 tables and a seat for every guest seated in the source,
  and a delete removes as many, against D1's daily row budget
  ([[free-tier-limits]]). The limiter is each isolate's own, so it bounds one
  person's burst, not a day.
- **The daily copy ceiling** bounds the day: a wedding copies at most 3,000
  tables and seats into new plans per UTC day (`MAX_COPIED_ROWS_PER_DAY` in
  `cire/api/src/schemas/seating.ts`), counted in `seating_copy_budget` and
  checked in the copy's own INSERT, so a copy past it is refused, 409
  `copy_budget`, and writes nothing. A blank plan copies nothing and is never
  refused for it. D1 bills a row written for the row and one for each index it
  enters (Cloudflare's D1 pricing page): four for a table or a seat, with their
  three indexes each, so one wedding's copies write at most about 12,000 rows a
  day.
- **The event's own addresses** act on its plan in use, which each write reads
  inside its own statements, not in a round trip before them. A table added at
  `…/events/:eventId/tables` makes that plan, "Plan 1", when the event has
  none, in the same batch, whose plan INSERT the partial unique index guards,
  so two first tables at once still make one plan. The event's reorder and
  seat addresses are the ones the portal before plans calls; an event with no
  plan seats nobody (a cleared seat is a no-op, a table is not found).

- **The chart** is one round trip: the event (id and name), its plans (the one
  in use first, then oldest first), the plan's tables, and its guests (name,
  reply, withdrawn, seat in that plan — what the screen and the print sheet
  show, and no more) as four SELECTs in one batch, the guests capped at 1,000
  (`MAX_CHART_GUESTS`; the tier cap keeps every real event under it). The plan
  is the one named by `plan`, or the plan in use; an event with no plan yet
  answers `planId: null`, no tables, and every guest unseated. A `plan` of
  another event or wedding answers 404.
- **A new plan** is one `INSERT … SELECT` from the event: it is this wedding's,
  it has room for another plan, and the plan is made in use when the event has
  none. **A copy** reads the source's table ids, mints new ones, and writes in
  one batch, one transaction on D1: the plan, its tables (name, capacity, and
  their place in the source's order, ties broken by creation and then id)
  through one bound JSON map of old id to new, its seats through the same map,
  and the day's count of rows copied. The plan's INSERT also checks that the
  source's tables and seats fit under the daily copy ceiling, and the tables,
  seats and count are written only where the new plan exists, so a copy
  refused for the cap, the ceiling or an unknown source writes nothing; a
  table added to the source after the read is not copied.
- **Putting a plan in use** is one batch: an UPDATE that clears the plan in use
  only when the named plan is a plan of this event of this wedding, then one
  that sets it. Two statements, because SQLite checks the one-selected index
  row by row. **Renaming** a plan leaves its `selected` as it was. **Deleting**
  one refuses the plan in use, and takes its tables and seats with it by
  cascade.
- **A seat or a move** is one batch, one transaction on D1: a conditional
  UPDATE that moves an existing seat in the plan, a conditional INSERT that
  seats a guest with none, and the seat after. Each write carries every rule in
  its own WHERE — the table is this plan's, it has room, the household is
  active; a new seat also needs the guest invited to the plan's event, which a
  guest already seated in the plan is — so a refused move changes nothing and
  the guest keeps the seat they had, and two requests for a table's last place
  cannot both land. The writes' `RETURNING` rows say whether it was
  a seat or a move; only a refusal reads again, to say why. An unseat is the
  plan check and a `DELETE … RETURNING`. No write touches another plan.
- **Reorder** is one statement: each table of the plan reads its new place
  from one bound JSON object keyed by id, and only a table whose place changed
  is written, so a keyboard step writes the two tables it swaps and the order
  lands whole. Ids are word characters and hyphens (the schema refuses
  anything else), which keeps them safe inside the JSON path.
- **`seating.csv`** lives with the other CSV exports in
  `createOrganiserExportRoutes`: every guest seated in each event's plan in
  use, by event, table, household and guest order, columns `Event, Table,
  Capacity, Guest, Household, RSVP`. No other plan, and no dietary column.
  Capped at 4,000 rows (`MAX_SEATING_EXPORT_ROWS`), read as one past the
  ceiling and logged when cut; `GET …/module-rows` counts `seats` in the plans
  in use for the locked card.

### What other writers do to seats

- **Import and editor saves** go through `diffAgainstDb`, which warns how many
  seats and tables a change clears, counted in every plan ("This change clears
  2 seats and removes 1 table from the seating chart." when one plan loses
  them, "… from 2 seating plans." when more do; "Reverting it does not bring
  them back."). The preview reads the count beside the RSVP warning's read, at
  the same time; the apply and every revert pass `warnings: false` and read
  neither, since nothing they run reads the warnings. The before-image a revert
  restores holds no seating, and the revert confirm says so. An event removal
  deletes the event's seats, tables and plans itself, before its invitations,
  in three statements for all removed events.
- **The retention sweep** deletes every seat, in every plan, at the swept
  weddings' events itself, before the invitations, and keeps the plans and
  tables with the rest of the wedding's shell.

## Portal

`cire/host/src/components/SeatingView.tsx`, loaded on demand from
`ModuleShell` (a Gold module's bytes are not paid by those who cannot open it).
One event at a time, chosen from the wedding's events, in its plan in use: the
chart read names no plan, adding, ordering and seating go to the event's own
addresses, and a table is renamed or deleted at `…/seating/tables/:tableId`.

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

- **A guest finding their seat** (englishstreetventures/osn#1412) is a read of
  the plan in use: the household's guest ids → the event's plan with `selected
  = 1` (the partial index) → `seating_assignments` by `(plan_id, guest_id)` →
  `seating_tables.name`.

## Observability

- Spans: `cire.seating.chart`, `.createPlan`, `.renamePlan`, `.selectPlan`,
  `.removePlan`, `.createTableAtEvent`, `.createTable`, `.updateTable`,
  `.removeTable`, `.reorderTables`, `.seat`, `.seatAtEvent`, `.loss`,
  `.exportCsv`.
- Counters (`cire/api/src/metrics.ts`, never an id): `cire.seating.plan.write`
  {`action`: create, duplicate, rename, select, remove — `create` also counts
  the plan a first table at an event makes};
  `cire.seating.table.write` {`action`: create, update, remove, reorder};
  `cire.seating.seat.write` {`action`: seat, move, unseat};
  `cire.seating.write.refused` {`reason`: table_full, table_limit,
  capacity_below_seated, household_withdrawn, plan_limit, plan_selected,
  copy_budget}.
- A request defect logs `seating request failed` with the wedding id and the
  operation, never a guest, plan or table name.

## Tests

| What | Where |
|---|---|
| The portal before plans on this API: the plan in use read, an event's first table making its plan, a seat in it, the venue file | `tools/e2e/tests/flows/cire-seating.flow.ts` |
| Gates, refusals, the database's one-seat, one-selected and table-in-its-event's-plan rules, plans, the daily copy ceiling, the event's own addresses, the plan limiter, who a chart holds, the CSV, the metrics, and what a failure answers and logs | `cire/api/tests/routes/seating.test.ts` |
| The same rules, the copy (with its day's count), select and event-address seat batches on real D1, a race for the last place and for an event's first plan, and the plans migration replayed with data from two weddings | `cire/api/tests/db/d1-integration.test.ts` (seating) |
| The plans migration: backfill across events and weddings, seats kept, the Worker before it replayed, the triggers | `cire/api/tests/db/migration-20261026040620.test.ts` |
| No full scan of any seating table | `cire/api/tests/db/seating-index.test.ts` |
| The CSV ceiling | `cire/api/tests/services/seating-export.test.ts` |
| Import warning across plans and explicit deletes | `cire/api/tests/services/import-seating.test.ts` |
| Retention deletes seats without the cascade, keeps plans and tables | `cire/api/tests/services/retention.test.ts` |
| The view's controls against a fake API | `cire/host/tests/components/SeatingView.test.tsx` |
| Real pointer drag, print, phone layout, screenshots | `cire/host/tests/components/SeatingView.browser.test.tsx` |

The flow writes its checks, requests and trace to `e2e-artifacts/`; the browser
tier writes the screenshots a reviewer checks, to
`cire/host/.vitest/attachments/seating/`.
