---
"@pulse/db": patch
---

Repair the Pulse migration chain so it can build the current schema

`pulse/db/drizzle/*.sql` could not be applied to an empty database, in either
filename or journal order, from two independent causes:

- A `user_id` → `profile_id` rename reached `src/schema` but never migration
  `0000`, so `0002` failed with `no such column: profile_id` and `0007` with
  `no such column: sent_by_profile_id`. Five columns across four tables were
  affected — `events.created_by_profile_id`, `event_rsvps.profile_id` and
  `invited_by_profile_id`, `pulse_users.profile_id`, `event_comms.sent_by_profile_id`
  — plus two index names. Corrected in `0000` in place: it restates what that
  migration always meant, and every later migration was already written against
  the new names.
- `events.chat_id`, `events.price_amount` and `events.price_currency` existed in
  `src/schema` with no migration adding them. Appended as
  `0009_events_chat_and_price.sql`, since those are genuinely later additions
  rather than a misspelling of history.

The practical consequence was that `wrangler d1 migrations apply pulse-db`
against a fresh D1 failed, so Pulse could not be deployed to D1 at all. Nothing
caught it because every Pulse test builds its database from `applySchema()`,
never from the migration chain.

Editing applied history is safe here and only here: every `database_id` in
`pulse/api/wrangler.toml` is still `placeholder-replace-after-d1-create`, so no
Pulse D1 exists in any tier whose applied-migrations table could contradict the
edit.

`pulse/db/tests/ddl-lockstep.test.ts` now guards both surfaces, matching the
tests already covering `@osn/db` and `@zap/db`.
