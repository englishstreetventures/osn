# cire Overview v2 — Richer Widgets Design

**Status:** Approved 2026-07-16
**Author:** (sole-driver session)
**Scope:** `cire/organiser` frontend only — no API, no DB, no migration.

## Goal

Turn the organiser Overview from five plain number/text cards into a richer
"how's the wedding tracking?" home: a full-width **"What's next"** timeline
band merging events + payments + tasks into one chronological agenda, plus
visual meaning (progress bars, per-event breakdown) on the existing cards.

## Non-Goals

- No backend, API, or schema changes. Every data source is already fetched by
  the Overview's existing `createResource` and the shared stores.
- No new module, sidebar entry, or route. This edits the Overview landing view
  in place.
- No synthetic "wedding day" agenda row — the Countdown card already owns the
  wedding-date headline.
- Not a full activity feed or analytics dashboard (Phase 2+ if ever).

## Context

The Overview (`cire/organiser/src/components/Overview.tsx`) currently renders,
for a non-fresh wedding, a 3-column grid of five cards:

1. **Countdown** — days to the wedding date.
2. **RSVPs** — rolled-up totals across events (attending/declined/maybe/no-reply).
3. **Guests & schedule** — household count, event count, guest estimate.
4. **Checklist** — live open-task count (links to the Checklist module).
5. **Budget** — live spend vs cap + next upcoming payment.

All data already flows through one `createResource` that loads, in parallel:
`/settings` (date, currency, cap), `/rsvps` (per-event tallies), and the shared
`events` / `guests` / `tasks` / `budget` stores. A brand-new wedding (no events,
no households) shows `GettingStarted` instead — unchanged by this work.

Key finding: the `/rsvps` response (`rsvpExportService.buildView`) already
carries, per event, `{ id, name, invited, attending, declined, maybe,
responded, noResponse }`. The Overview currently reads the tallies but ignores
`id`/`name`. The per-event RSVP breakdown therefore needs **no** API change —
only that the Overview stop discarding the event names.

## Data Available (all client-side already)

| Source | Shape (relevant fields) | Store / fetch |
|---|---|---|
| Events | `{ id, name, startAt (ISO datetime), … }` | `events-store` (`eventsAccessor`) |
| Tasks | `{ id, title, dueAt (YYYY-MM-DD \| null), status: "open"\|"done", … }` | `tasks-store` |
| Payments | `{ id, label, amountMinor, dueAt (YYYY-MM-DD \| null), paidAt (number\|null), … }` | `budget-store` (`peekCachedBudget`) |
| Budget items | `{ estimateMinor, quotedMinor, actualMinor, … }` | `budget-store` (drives spend rollup) |
| Budget cap | `budgetTotalMinor` | `budget-store` / `/settings` |
| RSVP per-event | `{ id, name, invited, attending, declined, maybe, responded, noResponse }[]` | `/rsvps` fetch (already in resource) |

## Components

### 1. `cire/organiser/src/lib/overview-agenda.ts` (new, pure, unit-tested)

Single responsibility: merge the three dated sources into one sorted agenda.
Pure — no Solid primitives, no fetch, `now` injected — so it is exhaustively
unit-testable.

```ts
export type AgendaKind = "event" | "payment" | "task";

export interface AgendaItem {
  /** Stable key: `${kind}:${sourceId}`. */
  key: string;
  kind: AgendaKind;
  /** Calendar date this item sits on (local), `YYYY-MM-DD`. */
  date: string;
  /** Primary label (event name / payment label / task title). */
  label: string;
  /** Optional trailing detail — formatted amount for payments, else null. */
  detail: string | null;
  /** Source row id, for navigation + dedupe. */
  sourceId: string;
  /** True when the date is strictly before `now`'s calendar date. Only
   *  payments/tasks can be overdue; past events are excluded entirely. */
  overdue: boolean;
}

export interface AgendaInput {
  events: { id: string; name: string; startAt: string }[];
  payments: { id: string; label: string; amountMinor: number; dueAt: string | null; paidAt: number | null }[];
  tasks: { id: string; title: string; dueAt: string | null; status: "open" | "done" }[];
  /** Injected clock (ms epoch). */
  now: number;
  /** Currency for formatting payment amounts. */
  currency: string;
  /** Upcoming (non-overdue) items beyond this many days ahead are dropped. */
  horizonDays: number;
  /** Max number of UPCOMING items to keep. Overdue items are always kept. */
  limit: number;
}

export function buildAgenda(input: AgendaInput): AgendaItem[];
```

**Rules:**

- **Events** — map `startAt` → local calendar date. Drop events whose date is
  before today (they already happened). Never marked overdue.
- **Payments** — include only `paidAt == null` (unpaid) with a non-null
  `dueAt`. `overdue` = `dueAt` calendar date < today. `detail` = amount
  formatted via `Intl.NumberFormat` currency (minor/100).
- **Tasks** — include only `status === "open"` with a non-null `dueAt`.
  `overdue` = `dueAt` < today. `detail` = null.
- **Undated** payments/tasks are excluded (nothing to place them on — they stay
  visible in their own module cards).
- **Sort** — overdue items first (oldest overdue at top), then upcoming ascending
  by date. Ties broken by kind order `event < payment < task` then label, so the
  order is deterministic (matters for tests).
- **Cap** — keep **all** overdue items; keep at most `limit` upcoming items
  within `horizonDays`. Upcoming beyond the horizon or beyond the cap are
  dropped.
- **Empty input** → `[]`.

**Date normalization helper (shared, local-calendar):** a small internal
`toLocalDateKey(value: string | number): string | null` that accepts an ISO
datetime, a `YYYY-MM-DD` string, or an ms-epoch number and returns a
`YYYY-MM-DD` key in local time (or null if unparseable). Reuses the same
local-midnight logic the Countdown already uses, so the agenda and countdown
never disagree by a day across timezones.

### 2. "What's next" timeline band (in `Overview.tsx`)

A full-width card rendered **under** the `SectionIntro` and **above** the stat
grid, only when the wedding is not fresh. Built from a `createMemo` over the
loaded stores calling `buildAgenda`.

- Each row: a compact **date pill** (e.g. "Aug 3"), a **kind icon**
  (event 📅 / payment 💰 / task ✓), the **label**, and right-aligned **detail**
  (amount for payments). Overdue rows carry a muted "overdue" flag/red accent.
- A row is a `<button>` that navigates via the existing `onNavigate`:
  event → `("schedule")`, payment → `("budget")`, task → `("checklist")`.
- **Empty state** (agenda empty but wedding not fresh): a single quiet line —
  "Nothing scheduled yet — add events, payment due dates, or task deadlines."
- Loading: rides the existing `data.loading` skeleton block (add one full-width
  skeleton bar above the grid skeletons).

### 3. Card visual upgrades (in `Overview.tsx`)

Small, self-contained additions to three existing cards. A shared inline
`<ProgressBar value max tone />` helper (pure presentational, `tone` ∈
`gold | over`) avoids three bespoke bar implementations.

- **RSVP card** — add a progress bar `responded / invited` (guard invited === 0)
  above the existing tally grid, and a compact **per-event attending**
  breakdown: one line per event `name … N attending`, from the retained
  per-event rsvp array. Cap the list (e.g. first 5 events) with a "+k more"
  affordance line if longer; the existing "See replies per event →" link stays.
- **Budget card** — add a spend-vs-cap bar `spentSoFar / budgetTotalMinor`
  (only when a cap is set). If `spent > cap`, bar renders full in the `over`
  tone (red) and the copy notes over-budget. Existing "of $X" line + next
  payment stay.
- **Checklist card** — show `N of M done` with a completion bar
  (`done / total`). Add a `taskCounts(weddingId): { open; done; total } | null`
  selector to `tasks-store` alongside the existing `openTaskCount` (returns null
  before the cache is populated, mirroring `openTaskCount`). The card reads it;
  keep the existing open-count headline.

## Data Flow

No new network calls. The Overview's existing `createResource`:

- Already loads events, guests, tasks, budget (into their shared caches) and
  `/rsvps`.
- **Change:** retain the per-event rsvp array (currently reduced to totals and
  discarded). Add `rsvpEvents: { id; name; attending; invited; … }[]` to the
  resource's returned `OverviewData` (keep the existing `rsvps` totals too).

Derived state is `createMemo`:

- `agenda()` = `buildAgenda({ events, payments, tasks, now: Date.now(),
  currency, horizonDays: 90, limit: 6 })`.
- Bar values read from existing selectors (`spentSoFar`, budget cap) + new
  `taskCounts`.

## Error Handling

Unchanged soft-fail model. Any source that failed to load is simply absent from
its slice of `buildAgenda` input (empty array) and its card falls back to the
existing "loading/empty" copy. The band and the three upgraded cards never throw
and never block the rest of the page.

## Defaults (locked)

- **Horizon:** 90 days for upcoming items.
- **Limit:** 6 upcoming items shown; **all** overdue items shown.
- **Per-event RSVP lines:** first 5 events, "+k more" if longer.
- No synthetic wedding-day row.

## Testing

- **`cire/organiser/src/lib/overview-agenda.test.ts`** (pure unit):
  - merges all three kinds and sorts ascending by date
  - excludes past events, paid payments, done tasks, and undated payments/tasks
  - surfaces overdue payments/tasks first, oldest overdue at top
  - respects `horizonDays` (drops far-future upcoming) and `limit` (caps
    upcoming but never overdue)
  - deterministic tie-break (same date → event < payment < task → label)
  - empty input → `[]`
  - `toLocalDateKey` handles ISO datetime, `YYYY-MM-DD`, ms-epoch, and garbage
- **`cire/organiser/src/components/Overview.test.tsx`** (component):
  - timeline band renders items in agenda order with correct icons/labels
  - clicking a payment/task/event row calls `onNavigate` with the right module
  - empty agenda (non-fresh wedding) shows the "Nothing scheduled yet" line
  - RSVP progress bar width reflects responded/invited; per-event lines render
    with names
  - Budget bar renders `over` tone when spent > cap
  - Checklist card shows "N of M done"

## Ship Shape

One branch, one PR. Tasks sequenced so each is independently reviewable:

- **Slice A:** `overview-agenda.ts` + its tests → timeline band + band tests.
- **Slice B:** `ProgressBar` helper + the three card upgrades + tests →
  retain per-event rsvp array in the resource.

Empty changeset (`@cire/*` are version-less/ignored). New wiki page
`cire/wiki/systems/overview.md` documenting the widgets + the agenda merge
rules; tick the Overview-widgets line in `cire/wiki/todo/platform.md`.

Built via subagent-driven-development (implementer → task review → fix loop per
task; final whole-branch review). No prod migration → normal merge, no
migration authorization needed.
