---
"@cire/api": patch
"@cire/host": patch
---

Give the events editor its own change scope, so it stops loading guests and households just to keep the diff safe.

`EventsEditor.loadInto` fetched `/events`, `/guests`, and `/households` in parallel, even though this tab only edits events. It had to: the editor's save always sent `scope: "both"`, and under that scope an omitted household reads as "delete this household." Loading the other two lists just to keep their rows present in the draft was the only way to avoid data loss.

`DesiredStateChangeBody` now carries an optional `scope`, and `decodeChangeBody` uses it when present (falling back to `"both"` for callers that still send the whole draft, such as `GuestsEditor`). `EventsEditor` now loads only events, seeds guests/households as empty, and posts `scope: "events"` on preview — so the diff skips guest and household removal entirely, and the two unrelated reads are gone. Apply is unchanged: it still posts only `{ changeId }`. `handleApply` still invalidates the events and guests caches — removing an event cascades into `guest_events` and `rsvps` — but no longer invalidates households, since no path through this editor can touch one.

Two review findings on that mechanism are fixed alongside it.

The first is the front door. `ChangeBody` is a union of an editor body and a
spreadsheet body, and before this branch the editor arm had no field that could
fail to decode, so a body carrying `desiredState` always won. The new `scope`
can fail, which for the first time made the spreadsheet arm reachable from a
malformed editor body — a request with `desiredState`, an invalid `scope` and an
`eventsCsv` field would silently decode as a CSV import, swapping the whole
write contract (`removeManual: false`, `matchByName: true`, a server-derived
scope) instead of returning 400. `ExclusiveFrontDoor` now refuses any body that
carries both `desiredState` and a sheet, so a malformed editor body always 400s.

The second is the apply-time fallback. Apply reads the scope back out of the
stored summary, and defaulting an unreadable one to `"both"` used to be the
conservative choice. It is not any more: an events-scoped draft legitimately
carries `families: []`, so re-diffing it at `"both"` reads every household as
absent and removes it. An editor row whose scope cannot be read is now refused
with a 409 that says so, and `EventsEditor` shows the server's own sentence
rather than its co-host wording, which would send the organiser looking for an
edit nobody made. A spreadsheet row keeps the `"both"` fallback: uploading a
sheet is itself the statement of which sheets it manages, so rows previewed
before this shipped still apply.
