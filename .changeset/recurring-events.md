---
"@pulse/db": minor
"@pulse/api": minor
"@pulse/app": minor
---

Introduce recurring event series.

- New `event_series` table + `series_id`/`instance_override` columns on `events`, with migration `0001_recurring_events.sql`.
- New `/series` API surface: `POST /series`, `GET /series/:id`, `GET /series/:id/instances`, `PATCH /series/:id` (scope: `this_and_following` | `all_future`), `DELETE /series/:id`.
- Reduced-grammar RRULE expander (`FREQ=WEEKLY|MONTHLY`, `INTERVAL`, `BYDAY`, `COUNT`, `UNTIL`) capped at `MAX_SERIES_INSTANCES = 260`.
- Series-level edits propagate to non-override future instances; patching a single instance flips `instanceOverride=true` so subsequent bulk edits skip it.
- `pulse.series.*` metrics (created / updated / cancelled / instances_materialized / rrule.rejected) with bounded string-literal attribute unions.
- Seed fixtures now include a weekly yoga series (with an overridden + cancelled instance) and a monthly book club.
- Frontend: "Part of a series" badge on event detail, repeat icon on event cards, new `/series/:id` page with Upcoming / Past tabs — all anchored on `pulse/DESIGN.md` tokens.
