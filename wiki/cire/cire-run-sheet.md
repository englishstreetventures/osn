---
title: Cire run sheet
tags: [systems, platform, tasks, cire]
related:
  - "[[cire-checklist-tasks]]"
  - "[[cire-auth]]"
  - "[[cire-guest-event-editor]]"
  - "[[cire-host-portal-layout]]"
  - "[[cire-entitlements]]"
  - "[[realtime]]"
last-reviewed: 2026-10-21
---
# Run sheet

The day of the wedding in one list: its events and the checklist tasks that
happen on the day, in the order they happen, with who does what. A Gold
module. Owners, editors and viewers read the whole day; a `helper` — someone
handed a job on the day — reads only as much as their seat's scope allows
([[cire-auth#The run-sheet scope]]). It is read-only for every role: a task's
time is set on its checklist row.

A task is on the run sheet when it has a time — a fixed one, or a link to an
event — or sits in the `day_of` bucket. Done tasks stay, marked done.

## A task's time

Migration `0093_task_run_time.sql` adds five nullable columns to `tasks`
([[cire-checklist-tasks]]), with `ALTER TABLE ADD` and no
rebuild. Only the task service and the schedule change write them, all five
together, so a task is always in one of four states. No CHECK constraint holds
them: the states live in `RunTimePatch` (`cire/api/src/schemas/tasks.ts`) and
the service.

| State | `run_at` | `run_timezone` | `event_id` | `run_offset_minutes` | `event_removed_at` |
|---|---|---|---|---|---|
| Untimed | NULL | NULL | NULL | NULL | NULL |
| Fixed | the time, `YYYY-MM-DDTHH:MM:SS±HH:MM`, the offset stamped from its zone | the IANA zone, as the organiser chose it | NULL | NULL | NULL |
| Linked | NULL | NULL | the event | minutes from its start, −1440..1440 | NULL |
| Frozen | the time it last had, on the removed event's clock | the removed event's zone | NULL | NULL | when the event went |

`event_id` references `events(id)` `ON DELETE SET NULL`, single-column on
purpose: a composite `(event_id, wedding_id)` key, like `task_assignees`',
would null `wedding_id` too, which is NOT NULL, and every event delete would
fail. That the event is the task's own wedding's is checked by every write
instead. The partial index `tasks_event_idx (event_id) WHERE event_id IS NOT
NULL` is the probe each event delete runs.

**A linked task's time is never stored.** It is the event's start moved by the
offset in real elapsed minutes, read on the event's own clock, so it follows
the event wherever it moves, day and zone included. Elapsed time, not
wall-clock arithmetic: an hour after 01:30 on the morning Sydney's clocks go
forward is 03:30, the instant an hour later, not a 02:30 that never happens.
`deriveRunTime` (`cire/api/src/lib/run-time.ts`) derives it for every answer
that carries a task — `GET /tasks`, every task write's answer, the starter
apply and the run sheet — as:

| Field | Meaning |
|---|---|
| `runAt` | when the task runs, `YYYY-MM-DDTHH:MM:SS±HH:MM`, or null |
| `runTimezone` | the zone `runAt` reads in — the event's, for a linked task |
| `eventId` | the linked event; null when none, or when the id names no event of the wedding |
| `runOffsetMinutes` | minutes from the event's start, negative before it; linked tasks only |
| `anchored` | linked to an event that was read: the time follows it |
| `eventRemoved` | a schedule change removed its event, and it kept its time |

### Setting it

`PATCH /api/organiser/weddings/:weddingId/tasks/:taskId` takes `runTime`, which
replaces the task's whole run time at once, so no write can leave half of one:

| `runTime` | Writes |
|---|---|
| `null` | untimed |
| `{ kind: "fixed", at, timezone }` | `at` (`YYYY-MM-DDTHH:MM`; any offset in it ignored) stamped with `timezone`'s offset for that date |
| `{ kind: "offset", eventId, offsetMinutes }` | a link, `offsetMinutes` a whole number within a day |
| `{ kind: "clock", eventId, at }` | a link: `at` is read on the event's clock and saved as minutes from its start; one more than a day away is 422 `run_time_out_of_range` |

A zone must be a real IANA zone — `"+10:00"` and `"UTC+10"` never move with
daylight saving and are refused — and is stored as sent. A link to anything
but an event of the task's own wedding is 422 `event_not_in_wedding`, and
neither 422 writes any field of the patch (the UPDATE's WHERE requires the
event; a probe in the same batch tells it from 404 `task_not_found`, which
wins). Any `runTime` write clears `event_removed_at`. A clock time reads the
event first, so it is counted from the event's live start. Like every task
write it is `weddingEditor`, Gold and the task-write limiter, and publishes
`tasks-changed` only once it commits.

## `GET /run-sheet`

`GET /api/organiser/weddings/:weddingId/run-sheet`
(`cire/api/src/routes/run-sheet.ts`) is mounted behind `weddingRunSheet()`,
never `weddingMember()`, which refuses a helper; then `weddingTier(db,
"gold")`, 402 below Gold for every role, a helper included; then a
per-organiser limiter of 120 a minute (`defaultRunSheetReadLimiter` in
`cire/api/src/app.ts`; 429 with `retry-after: 60`): a read can look up names
over ARC, and every publish sends each open run sheet to read again.
`cache-control: no-store`.

```ts
{
  scope: "own" | "full",
  viewerHostId: string,
  items: (
    | { kind: "event"; id; name; startAt; endAt; timezone; venueName; address }
    | { kind: "task"; id; title; notes; status; runAt; runTimezone; eventId;
        runOffsetMinutes; anchored; eventRemoved; assigneeHostIds }
  )[],
  people: { hostId; osnProfileId; handle?; displayName?; avatarUrl? }[],
}
```

**Narrowed on the server, and nowhere else** (`runSheetService.read`,
`cire/api/src/services/run-sheet.ts`). For `own`: only the tasks the reader's
seat holds (`runSheetVisibleTo`), only the events those tasks link to, only
the people holding them. For `full`: every listed task, every event, every
holder. Every reader gets an event's name, times, zone, venue name and address,
and no other field. No count or total rides alongside. People carry no role,
and their names are looked up for them alone, fail-soft: an unreachable lookup
leaves profile ids. One batch of four reads (listed tasks, holders, events,
seats), then the narrowing in the Worker.

**Order** (`orderRunSheet`, `cire/api/src/lib/run-sheet.ts`): by instant, not by
the text of the time, so a Kolkata time sits between two Sydney times when it
happens between them. At one instant an event goes before a task — so a task
linked to one event that lands on another's start reads after that event —
two events go by schedule order and two tasks by checklist order, then id. An
item whose time cannot be read goes after every timed one; untimed tasks ("any
time on the day") last.

## When a schedule change removes an event

Only the schedule change deletes events ([[cire-guest-event-editor]]). Its
preview lists the checklist tasks linked to each event it removes
(`plan.linkedTasks`: id, title, event, offset, and the time it would keep), and
asks whether to remove them too. The apply body's `removeLinkedTasks` names the
ones chosen; absent — an older portal, or nothing chosen — keeps every one.

Each removed event commits as **one batch** with its tasks
(`removedEventGroup` in `cire/api/src/services/import.ts`; the write set is
committed in groups, never split across batches):

1. the chosen tasks still linked to it are deleted, a seeded task's dismissal
   written first so the starter does not bring it back;
2. every other task still linked to it is frozen — unlinked, at the time the
   diff computed for its offset, on the event's clock, marked removed;
3. its RSVPs, invitations and the event.

A task relinked to a surviving event since the preview is neither removed nor
frozen. A task linked to the removed event since the preview, at an offset
the preview never read, is frozen with no time rather than left half-set.

The stored change summary records `linkedTasksKept` and `linkedTasksRemoved`,
and the revert's confirmation says kept tasks stay unlinked and removed ones are
not restored. A revert passes no removal list, so a revert that removes events
freezes their tasks too.

An apply or revert that created, updated or removed an event publishes
`tasks-changed` after it commits, and after one that failed part way (some
batches may have committed); one that touched only the guests publishes
nothing ([[realtime]]).

## In the portal

`RunSheetView.tsx` is the Run sheet module and the whole of a helper's seat;
`RunTimeEditor.tsx` sets a task's time from its checklist row. How both look,
and why, is `cire/host/DESIGN.md` §7; where they sit in the layout is
[[cire-host-portal-layout#Layout switches worth knowing]].

### Where it opens

- **Module.** "Run sheet", after the Checklist, locked below Gold
  (`module-nav.ts`); `ModuleShell` mounts `RunSheetView`.
- **A helper's seat.** `RunSheetSeat` in `OrganiserApp.tsx` mounts the same
  view under the panel header the shell gives every module, inside the
  wedding's cache scope, so its rows go with the seat. Below Gold the co-host
  panel offers the role as "Helper (needs Gold)".

### What the run sheet shows

- **The day, on its own clocks.** Rows come in the API's order, by instant,
  grouped under the local date each falls on in its own zone: an event's
  `timezone`, a task's `runTimezone` (its event's, when linked). Times are
  formatted there with `Intl` (`lib/run-sheet-display.ts`), never in the
  browser's zone. A day in one zone names it once beside its heading ("Times in
  AEST"); a day that mixes zones puts the zone under every time. Untimed tasks
  come last, under "Any time on the day".
- **Events** show their name, start and end ("to 12:30 am Sun" past
  midnight), venue name and address.
- **Tasks** show their time, title, notes and holders (the read-only avatar
  stack, the reader first). A linked task says where it sits against its
  event: "30 min before Ceremony", "At the start of Ceremony", "3 hr 30 min
  after Reception".
- **Flags**, each a word and a glyph: "You" on the reader's tasks
  (`isOwnTask`; also `data-own` and a bar at the row's start), "Coming up"
  (`data-coming-up`), "Done" (struck through, left in its slot) and "Event
  removed".
- **Coming up** runs from 30 minutes before a task until it starts; done tasks
  never are. Decided in the browser against its own clock (`isComingUp`,
  `nextComingUpChange` in `cire/host/src/lib/run-sheet.ts`): a timer is set for
  the next change and re-armed when it fires, and the clock is read again when
  the tab becomes visible. Neither sends a request.
- **Owners and editors** get "Change times on the checklist", which opens the
  Checklist. The run sheet itself is read-only for every role.
- **An `own` helper** sees "Your tasks for the day" above their rows.

| State | What it shows | Request |
|---|---|---|
| Below Gold | "The run sheet isn't available for this wedding." — no plan named | none |
| 402 | the same line | the one refused |
| 401 | sends the reader to sign in | — |
| 403, 404, any failure | "Couldn't load the run sheet." with Try again | — |
| Loading | `PanelLoading` | — |
| Empty, `full` | "Nothing is timed for the day yet.", and for an owner or editor "Set times on the checklist" | — |
| Empty, `own` | "Nothing on the run sheet is yours yet." | — |

### Live refresh

`run-sheet-store.ts` is a reread cache (`reread-cache.ts`) on the checklist's
write tracker (`task-writes.ts`): a read across one of the tab's own task
writes is dropped and sent again, and a run sheet cached before one reads
again the next time it opens, push or no push. Every listening tab marks it
stale on `tasks-changed`, `members-changed` and a reconnect; a mounted view
reads again on both signals. A tab that applied or reverted a schedule change
drops the checklist and the run sheet (`scheduleChanged`). See
[[cire-host-portal-layout]].

### Setting a time on the checklist

Each checklist row shows its task's time, on the task's own clock, with the
zone when that is not the reader's. For an owner or editor it is the
`RunTimeEditor` trigger — an empty dotted slot with a clock when the task has
no time — and opens a popover:

- **Event**: "No event — a fixed time", or one of the wedding's events (read
  the first time a popover opens on the page, through `ensureEventsLoaded`).
- **Linked**: "Before or after the start" (minutes up to 1440, before or
  after; sent as `offset`) or "At a clock time" (a date and time on the
  event's clock; sent as `clock`, which the API turns into an offset). No zone
  is asked for.
- **Unlinked**: a date, a time and a zone (sent as `fixed`); the zone defaults
  to the one every event shares, else the browser's.
- **Clear time**, only when the task has one (sent as `null`).

It saves through `saveTaskRunTime` (`cire/host/src/lib/run-time-write.ts`)
inside one of the portal's own task writes, closes, and puts the focus back on
the trigger; the row is kept (`ChecklistView`'s row memo reads the run-time
fields live). A 200 whose task carries no time is an API older than run times,
and reads "This time wasn't saved — reload and try again."; a 422 reads "That
event is gone — pick another." or "Pick a time within a day of the event.";
anything else "Couldn't save the time."; a 401 sends the organiser to sign in.
Anyone else sees the time as text, and nothing on an untimed task.

## Observability

| Signal | What |
|---|---|
| Span `cire.run_sheet.read` | the read; a defect logs `run sheet read failed` with `weddingId` and `scope` only |
| `cire.run_sheet.read.completed` (`{request}`) | `scope: own \| full`, `result: ok \| error` |
| `cire.tasks.run_time.changed` (`{request}`) | `kind: fixed \| offset \| clock \| clear`, `result: ok \| event_not_in_wedding \| out_of_range \| task_not_found \| error` |
| `run sheet names unresolved` (warning) | the name lookup failed; `weddingId` only |
| `import applied: …` (info) | gains `linkedTasksKept` / `linkedTasksRemoved`, counts only |

A task's title and notes, a person's name, handle or profile id, and an
event's name or address never reach a log ([[cire-guest-data]] records why
titles and notes are sensitive).

## Releases in either order

| Serving | Meets | Behaviour |
|---|---|---|
| New portal | API older than run times | `GET /run-sheet` is 404, which the view shows as a quiet error; a time saved is "not saved" |
| Old portal | New API | its apply sends no `removeLinkedTasks`, so every linked task is kept, frozen |

## Tests

- `cire/api/tests/lib/run-time.test.ts` — elapsed-time derivation and clock
  offsets at the 2099 Sydney transitions (4 October, 5 April), zones, ranges.
- `cire/api/tests/lib/run-sheet.test.ts` — the order, one case per tie.
- `cire/api/tests/routes/tasks.test.ts` ("a task's run time") — every refusal
  writing nothing, every kind, the answers, publishes.
- `cire/api/tests/routes/run-sheet.test.ts` — the role and scope matrix, the
  raw-text absence of everything an `own` helper must not get, gates, limiter,
  names, failure.
- `cire/api/tests/services/import-linked-tasks.test.ts` and
  `tests/routes/organiser-changes.test.ts` — the preview list, keep and remove,
  races, dismissals, one batch per removed event, revert, publishes, counts.
- `cire/api/tests/db/migration-0093.test.ts`, `tasks-event-index.test.ts`,
  `d1-integration.test.ts` — the migration keeps every row, the SET NULL, the
  index.
- `cire/host/tests/lib/run-sheet-store.test.ts`, `run-sheet.test.ts`,
  `run-time-write.test.ts`; `tasks-store.test.ts`, unedited across the move
  into `reread-cache.ts`.
- `cire/host/tests/components/RunSheetView.test.tsx` and
  `RunTimeEditor.test.tsx` — the screens' contract: the states and their copy,
  grouping by each row's zone, the flags, the timer and tab wake, the re-reads,
  and every kind of write the editor sends.
- `cire/host/tests/components/RunSheetView.browser.test.tsx` and
  `RunTimeEditor.browser.test.tsx` — painted in Chromium at 390 and 1280px in
  both ramps: markers on the thread, the holders' column, every word at
  4.5:1, the popover inside the screen, Tab kept inside it, the focus back on
  the trigger after a keyboard save ([[browser-tests]]).
