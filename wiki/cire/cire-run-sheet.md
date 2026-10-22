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

The day of the wedding in one list: its events, each with its run of show,
and the checklist tasks that happen on the day, in the order they happen, with
who does what. A Gold
module. Owners, editors and viewers read the whole day; a `helper` — someone
handed a job on the day — reads only as much as their seat's scope allows
([[cire-auth#The run-sheet scope]]). It is read-only for every role: a task's
time is set on its checklist row.

A task is on the run sheet when it has a time — a fixed one, or a link to an
event — or sits in the `day_of` bucket. Done tasks stay, marked done.

## A task's time

Migration `20261021153838_task_run_time.sql` adds five nullable columns to `tasks`
([[cire-checklist-tasks]]), with `ALTER TABLE ADD` and no
rebuild. Only the task service and the schedule change write them, all five
together, so every write leaves a task in one of the five states below. No
CHECK constraint holds them: the states live in `RunTimePatch`
(`cire/api/src/schemas/tasks.ts`) and the service.

| State | `run_at` | `run_timezone` | `event_id` | `run_offset_minutes` | `event_removed_at` |
|---|---|---|---|---|---|
| Untimed | NULL | NULL | NULL | NULL | NULL |
| Fixed | the time, `YYYY-MM-DDTHH:MM:SS±HH:MM`, the offset stamped from its zone | the IANA zone, as the organiser chose it | NULL | NULL | NULL |
| Linked | NULL | NULL | the event | minutes from its start, −1440..1440 | NULL |
| Frozen | the time it last had, on the removed event's clock | the removed event's zone | NULL | NULL | when the event went |
| Frozen, no time | NULL | NULL | NULL | NULL | when the event went — the event's start could not be read, or the task was linked after the change read its offsets |

One more shape exists that no writer leaves: an event deleted by anything but
the schedule change — the wedding's own cascade deletes its tasks too, so in
practice a Worker from before these columns, mid-deploy — has its `event_id`
nulled by the foreign key, and `run_offset_minutes` stays. It carries no event
and no time, so `deriveRunTime` reads it as untimed, not linked; the next
run-time write replaces all five columns.

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
    | { kind: "event"; id; name; startAt; endAt; timezone; venueName; address;
        runOfShow: { time; label }[] }
    | { kind: "task"; id; title; notes; status; runAt; runTimezone; eventId;
        runOffsetMinutes; anchored; eventRemoved; assigneeHostIds }
  )[],
  people: { hostId; handle?; displayName?; avatarUrl? }[],
}
```

**Narrowed on the server, and nowhere else** (`runSheetService.read`,
`cire/api/src/services/run-sheet.ts`). For `own`: only the tasks the reader's
seat holds (`runSheetVisibleTo`), only the events those tasks link to, only
the people holding them. For `full`: every listed task, every event, every
holder. Every reader gets an event's name, times, zone, venue name, address
and run of show, and no other field. The run of show rides on its event, so an
`own` reader gets the items of the events they are given and of no other. It is
answered in the organiser's order (`sort_order`), each item's `time` an `HH:MM`
on the event's own clock, as `GET …/events` answers it
([[cire-guest-event-editor]]); the portal orders it. No count or total rides
alongside. A person is their seat id — what a task's `assigneeHostIds` name —
and the handle, display name and photo URL OSN gives them: no role, and no OSN
profile id. Names are looked up for those people alone, fail-soft: an
unreachable lookup leaves each their seat id alone. The lookup goes through a
per-isolate cache (`cacheProfileDisplayResolver` in
`cire/api/src/services/osn-bridge.ts`: five minutes, 500 profiles, oldest out
first, only profiles OSN named), so a burst of re-reads costs one ARC call per
isolate, and only for profiles it does not hold; a renamed person shows their
old name for at most five minutes. It holds display data alone and is asked
only for people the narrowing already chose. `GET …/hosts` keeps the uncached
lookup.

One batch of four reads (listed tasks, holders, events — each carrying its run
of show as one JSON column, `runOfShowColumn` in
`cire/api/src/services/run-of-show.ts` — and seats), then the narrowing in the
Worker. For `own` each read already keeps to the reader's tasks in SQL — the
tasks their seat holds, those tasks' holders and events, the seats holding them
— so a helper's read does not grow with the rest of the wedding; the Worker's
narrowing still decides what is answered. The tasks are read unsorted:
`orderRunSheet` puts the whole day in order.

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

The events a change removes commit as **one group** with their tasks, so in
one batch: at most six statements however many events go, each binding its ids
as one JSON parameter (`removedEventsGroup` in `cire/api/src/services/import.ts`;
the write set is committed in groups, never split across batches):

1. the chosen tasks still linked to a removed event are deleted, a seeded
   task's dismissal written first so the starter does not bring it back;
2. every other task still linked to one is frozen — unlinked, at the time the
   diff computed for its event and offset, on its event's clock and in its
   zone, marked removed;
3. their RSVPs, invitations and the events.

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
nothing ([[realtime]]). A change to one event's run of show and nothing else
publishes too: every event a schedule change keeps is in its plan as an update,
so the run sheet, which shows the run of show, reads again.

## In the portal

`RunSheetView.tsx` is the Run sheet module and the whole of a helper's seat;
`RunTimeEditor.tsx` sets a task's time from its checklist row. How both look,
and why, is `cire/host/DESIGN.md` §7; where they sit in the layout is
[[cire-host-portal-layout#Layout switches worth knowing]].

### Where it opens

- **Module.** "Run sheet", after the Checklist, locked below Gold
  (`module-nav.ts`); `ModuleShell` mounts `RunSheetView`, which is its own
  chunk, loaded the first time it opens (as the seating chart is), behind
  `PanelLoading`.
- **A helper's seat.** `RunSheetSeat` in `OrganiserApp.tsx` mounts the same
  view, from the same chunk, under the panel header the shell gives every
  module, inside the wedding's cache scope, so its rows go with the seat. Below
  Gold the co-host panel offers the role as "Helper (needs Gold)".

### What the run sheet shows

- **The day, on its own clocks.** Rows come in the API's order, by instant,
  grouped under the local date each falls on in its own zone: an event's
  `timezone`, a task's `runTimezone` (its event's, when linked). Times are
  formatted there with `Intl` (`lib/run-sheet-display.ts`), never in the
  browser's zone. A day in one zone names it once beside its heading ("Times in
  AEST"); a day that mixes zones puts the zone under every time. Untimed tasks
  come last, under "Any time on the day".
- **Events** show their name, start and end ("to 12:30 am Sun" past
  midnight), venue name and address, and their **run of show** inside the
  event's band: read-only, in the order the guest's sheet reads it —
  `guestOrder` in `cire/host/src/lib/event-guest-details.ts`, from the event's
  start on its own clock, an item earlier on the clock than the start last
  and marked "(after midnight)" — each time its own `HH:MM` as written
  (`clockLabel`). The items are not rows: no marker on the thread, no flags,
  nobody holding them. A task still links only to an event's start.
- **Tasks** show their time, title, notes and holders (the read-only avatar
  stack, the reader first). A holder OSN gave no name is a face alone, and the
  holders' text counts them ("Held by 2 people") rather than naming anyone. A linked task says where it sits against its
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
  Their starts are read on their own clocks when a popover asks, once for each
  events list however many rows offer it, never as the rows mount.
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
event's name, address or run of show never reach a log ([[cire-guest-data]] records why
titles and notes are sensitive).

## Releases in either order

| Serving | Meets | Behaviour |
|---|---|---|
| New portal | API older than run times | `GET /run-sheet` is 404, which the view shows as a quiet error; a time saved is "not saved" |
| Old portal | New API | its apply sends no `removeLinkedTasks`, so every linked task is kept, frozen; it does not read `runOfShow` |
| New portal | API without the run of show on the run sheet | the store reads an absent `runOfShow` as none: the bands show no items |

## Tests

- `cire/api/tests/lib/run-time.test.ts` — elapsed-time derivation and clock
  offsets at the 2099 Sydney transitions (4 October, 5 April), zones, ranges.
- `cire/api/tests/lib/run-sheet.test.ts` — the order, one case per tie.
- `cire/api/tests/routes/tasks.test.ts` ("a task's run time") — every refusal
  writing nothing, every kind, an offset and a clock time exactly a day either
  side of the start, the answers (each reading its events with its tasks),
  publishes.
- `cire/api/tests/routes/run-sheet.test.ts` — the role and scope matrix, the
  raw-text absence of everything an `own` helper must not get (other events'
  runs of show included), every event's run of show for the others, the exact
  event fields and a person's (no profile id), gates (the session cookie live
  and dead, the whole 402), limiter, names asked once in five minutes, what
  each read fetches for `own` and `full`, failure.
- `cire/api/tests/services/import-linked-tasks.test.ts` and
  `tests/routes/organiser-changes.test.ts` — the preview list, keep and remove,
  races, dismissals, every removed event and its tasks in one group of single
  statements, the chosen tasks' delete and dismissal in the batch that deletes
  their event, revert, publishes (a change to a run of show alone included),
  counts; the guest cap still checked on each batch's last guest insert.
- `cire/api/tests/services/osn-bridge.test.ts` — the name cache: a repeat
  within five minutes, only misses sent, nothing kept for an unnamed profile or
  a failure, the oldest out first.
- `cire/api/tests/db/migration-20261021153838.test.ts`, `tasks-event-index.test.ts`,
  `d1-integration.test.ts` — the migration keeps every row, the SET NULL, the
  index; the run sheet's one-batch read over D1, runs of show included, and an
  `own` read narrowed in SQL; the checklist's joined read; a two-event removal
  with a chosen and a kept task.
- `cire/host/tests/lib/run-sheet-store.test.ts`, `run-sheet.test.ts`,
  `run-time-write.test.ts`; `tasks-store.test.ts`, unedited across the move
  into `reread-cache.ts`.
- `cire/host/tests/components/RunSheetView.test.tsx` and
  `RunTimeEditor.test.tsx` — the screens' contract: the states and their copy,
  grouping by each row's zone, the flags, the timer (one timer of the longest
  wait a browser keeps for a flag weeks away) and tab wake, the re-reads, a
  holder with no name, an event's run of show ordered across midnight on its
  own zone and kept inside its band, every kind of write the editor sends, and
  the events' starts read once, when a popover opens.
- `tools/e2e/tests/flows/cire-helper-scope.flow.ts` — end to end, after the
  scope steps and on the same sign-in: an owner's day in order on Sydney's
  clock with the browser in UTC, "Coming up" at a held 10:05, a run of show
  across midnight inside its band; an event moved in the Events editor and
  its task moving with it; an event removed keeping its task and one removed
  with it; and a helper seeing their own tasks, whose `GET …/run-sheet` holds
  only their task, its event and that event's run of show. Screenshots in
  `e2e-artifacts/screenshots/cire-helper-scope--*.png`.
- `cire/host/tests/components/RunSheetView.browser.test.tsx` and
  `RunTimeEditor.browser.test.tsx` — painted in Chromium at 390 and 1280px in
  both ramps: markers on the thread, the holders' column, a run of show inside
  its band, every word at 4.5:1, the popover inside the screen, Tab kept inside it, the focus back on
  the trigger after a keyboard save ([[browser-tests]]).
