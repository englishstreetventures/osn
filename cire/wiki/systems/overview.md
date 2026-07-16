---
title: Organiser Overview
tags: [systems, cire, organiser]
related: [checklist-tasks, budget]
last-reviewed: 2026-07-16
---

# Organiser Overview

The Overview (`cire/organiser/src/components/Overview.tsx`) is the module shell's
landing view: "how's the wedding tracking?" at a glance. For a brand-new wedding
(no events, no households) it shows `GettingStarted` instead.

## Widgets

- **What's next** (full-width band) — one chronological agenda merging upcoming
  schedule events, unpaid budget payments with a due date, and open checklist
  tasks with a due date. Built by the pure `lib/overview-agenda.ts`
  (`buildAgenda`). Overdue payments/tasks surface at the top; past events are
  excluded. Horizon 90 days, ≤ 6 upcoming items + all overdue. Each row links to
  its module (event → Schedule, payment → Budget, task → Checklist).
- **Countdown** — days to the wedding date.
- **RSVPs** — rolled-up totals + a responded/invited progress bar + a per-event
  attending breakdown (first 5 events). Data from `/rsvps` (already per-event).
- **Guests & schedule** — household + event counts, guest estimate.
- **Checklist** — open-task count + an N-of-M completion bar (`taskCounts`).
- **Budget** — spend vs cap with a bar (red when over) + the next payment.

## Data

No dedicated Overview endpoint. Everything is read from the shared weddingId-keyed
stores (events, guests, tasks, budget) plus light `/settings` + `/rsvps` reads,
all fired in parallel by one `createResource`. Any source that fails to load
simply contributes nothing to its widget (soft-fail) — the page never blanks.

## Agenda merge rules (`overview-agenda.ts`)

Pure + unit-tested. `now` is injected. All dates normalised to a local
`YYYY-MM-DD` key via `toLocalDateKey` (accepts ISO datetime / date string /
ms-epoch) so the agenda never disagrees with the Countdown across timezones.
Excludes: past events, paid payments, done tasks, undated payments/tasks.
Deterministic tie-break: same date → event < payment < task → label.
