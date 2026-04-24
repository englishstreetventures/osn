---
"@pulse/api": minor
"@pulse/app": patch
"@pulse/db": minor
"@shared/observability": minor
---

Pulse: prompt for max event duration + new `maybe_finished` event status.

Organisers creating an event now see a set of duration presets (1h / 2h / 4h /
8h / All day) when the end time is left blank, plus a hint that an event
without an explicit end time will be marked **maybe finished** after 8 hours
and **automatically closed** after 12 hours. Organisers can manually close an
event at any time.

Schema: adds `"maybe_finished"` to the `events.status` enum (pure TS — no SQL
migration; the column is plain text). The `EventStatus` union in
`@shared/observability` and the service/route Effect + TypeBox schemas are
updated in lockstep.

Server: `deriveStatus` in `pulse/api/src/services/events.ts` now auto-
transitions ongoing events with no `endTime` to `"maybe_finished"` at 8h past
`startTime` and to `"finished"` at 12h. Events with an explicit `endTime`
keep the original single-transition behaviour, and the 48h
`MAX_EVENT_DURATION_HOURS` cap is enforced on both `POST /events` and
`PATCH /events/:id` (including patches that change only `startTime` or only
`endTime`) — rejections return 422 and emit
`metricEventValidationFailure(op, "duration_exceeds_max")`.
