---
"@cire/api": patch
"@cire/organiser": patch
---

Drop the UTC offset from event editing — an event's time is a wall clock plus a timezone.

The host portal still showed a timezone *and* a UTC offset when editing events:
the schedule editor's summary rows printed the raw stored
`2026-11-14T15:00:00+11:00`, the drawer's zone hint appended "— UTC+11:00 on
this date", the events table's can't-format fallback printed the stored string,
and the CSV template, parser and format guidance all asked for an
ISO-8601-with-offset `Start` right beside a `Timezone` column. Two ways to say
one thing, and on the sheet path they could disagree: `+10:00` is right for
Sydney in July and wrong for Sydney in November, and nothing caught it.

An event's time is now stated one way everywhere — a **local wall clock plus an
IANA zone**:

- The CSV template emits `2026-11-14T15:00`, and the guidance and error copy
  match. New `cire/api/src/lib/event-time.ts` reads the local clock out of a
  Start/End cell (**discarding any offset or `Z` — the Timezone column is
  authoritative**) and stamps the offset that zone is on for the event's own
  date, DST included. A stale offset in a cell is corrected rather than
  believed.
- The events parser now requires a **resolvable IANA `Timezone`**. It needs one
  to derive the offset, and an unresolvable zone was already a broken event —
  the guest site formats every event time with `timeZone: event.timezone`, which
  throws on an unknown identifier.
- Both re-importable CSV exports write the wall clock, so export → edit →
  re-import speaks the same language as the template and the editor. The
  existing export → parse → diff fixpoint test proves nothing is lost.
- New `cire/organiser/src/lib/event-display.ts` gives the events table and the
  editor's rows one formatter, whose degraded paths print the wall clock rather
  than the raw value — including for a half-filled draft, which `Date` reads as
  UTC midnight and which used to render as an invented "11:00 am" on a row whose
  save was blocked for having no time.

The stored column is deliberately unchanged: `events.start_at` keeps its derived
offset, because the guest site reads it as an instant (day/time render, `.ics`,
Google Calendar link) and event ordering sorts on it. The offset is now strictly
internal — derived, never typed, never displayed.
