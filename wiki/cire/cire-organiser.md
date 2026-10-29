---
title: Cire organiser overview
tags: [systems, cire, organiser]
related:
  - "[[cire]]"
  - "[[cire-checklist-tasks]]"
  - "[[cire-budget]]"
  - "[[cire-platform-plan]]"
  - "[[cire-landing]]"
last-reviewed: 2026-10-29
---
# Organiser Overview

The Overview (`cire/host/src/components/Overview.tsx`) is the module shell's
landing view: "how's the wedding tracking?" at a glance. For a brand-new wedding
(no events, no households) it shows `GettingStarted` instead.

## Widgets

- **What's next** (full-width band) — one chronological agenda merging upcoming
  schedule events, unpaid budget payments with a due date, and open checklist
  tasks with a due date. Built by the pure `lib/overview-agenda.ts`
  (`buildAgenda`). Overdue payments/tasks surface at the top; the agenda drops
  past events. Horizon 90 days, ≤ 6 upcoming items + all overdue. Each row links to
  its module (event → Schedule, payment → Budget, task → Checklist).
- **Countdown** — days to the wedding date.
- **RSVPs** — rolled-up totals + a responded/invited progress bar + a per-event
  attending breakdown (first 5 events). Data from `/rsvps` (already per-event).
- **Guests & schedule** — household + event counts, guest estimate.
- **Checklist** — open-task count + an N-of-M completion bar (`taskCounts`).
- **Budget** — spend vs cap with a bar (red when over) + the next payment.

## Data

No dedicated Overview endpoint. The Overview reads everything from the shared
weddingId-keyed stores (events, guests, tasks, budget) plus light `/settings` +
`/rsvps` reads, all fired in parallel by one `createResource`. Any source that
fails to load contributes nothing to its widget (soft-fail) — the page never blanks.

## Agenda merge rules (`overview-agenda.ts`)

Pure + unit-tested. `now` is injected. All dates normalised to a local
`YYYY-MM-DD` key via `toLocalDateKey` (accepts ISO datetime / date string /
ms-epoch) so the agenda never disagrees with the Countdown across timezones.
Excludes: past events, paid payments, done tasks, undated payments/tasks.
Deterministic tie-break: same date → event < payment < task → label.

## The wedding list

Before a wedding is open, the portal shows `WeddingList`
(`cire/host/src/components/WeddingList.tsx`): the organiser's weddings to open,
the ones they deleted and can still restore, and the create form. With no
weddings the form shows at once; otherwise it opens behind "+ Create a wedding".

### Arriving from the marketing site

cireweddings.com's closing field links here as `/?name=<the couple's names>`
([[cire-landing#The claim field]]). `WeddingList` opens the create form with the
names in its field, even for an organiser who already has weddings, and drops
`name` from the address at once, so a reload or a second wedding starts empty.
The value comes from a link anyone can write, so `lib/name-prefill.ts`:

- strips the control characters other than whitespace, the characters that
  reorder text around them (U+202A–202E, U+2066–2069, U+200E, U+200F, U+061C)
  and the ones that draw nothing (U+00AD, U+180E, U+200B, U+2060–2064, U+FEFF,
  U+FFF9–FFFB, the tag characters U+E0000–E007F). The zero-width joiner and
  non-joiner stay, for emoji sequences and Persian and Indic names; a
  subdivision flag such as England's, built from tag characters, arrives as a
  plain black flag;
- turns each run of whitespace, line breaks and Unicode spaces included, into
  one space, so padding cannot push text past the field's edge, then trims;
- cuts it to 120 UTF-16 units, the length cire-api's `MAX_DISPLAY_NAME` check
  counts, never splitting a character;
- only fills the field. Nothing submits until the organiser presses "Create
  wedding", and the name is shown nowhere else.

Letters that draw as blank space, such as the Hangul filler (U+3164), pass: no
character class removes them without refusing real names. The organiser
reading the field before pressing "Create wedding" is what catches a name that
is not theirs.

A signed-out visitor keeps the parameter through sign-in: `RequireAuth` sends
them to `/login?returnTo=/?name=…`, and `SignInPanel` returns them to that path,
as it does any same-origin path. Tests: `WeddingList.prefill.test.tsx` and
`SignInPanel.test.tsx` in `cire/host/tests/components/`, and the
`cire-checklist-starter` E2E flow, which arrives at `/?name=Amara%20%26%20Sam`
signed out, signs in from the `/login?returnTo=` it is sent to, finds the names
in the form and gone from the address, and cancels with nothing sent. The
marketing site's half, the link itself, is `cire-landing-home`'s
([[cire-landing#Tests]]).
