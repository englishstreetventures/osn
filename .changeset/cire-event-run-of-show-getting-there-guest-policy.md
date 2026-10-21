---
"@cire/db": minor
"@cire/api": minor
"@cire/host": minor
"@cire/invites": minor
"@tools/e2e": patch
---

Organisers can give each event a run of show, getting-there notes and a guest policy, and guests see them

- **The organiser's event drawer** gains a **Run of show**: a list of items,
  each a time and a name, added, removed and reordered by drag or from the
  keyboard (the grip's Arrow keys, or the move buttons a screen reader
  reaches). An item earlier on the clock than the event's start is marked as
  reading after midnight. The drawer also gains **Getting there** notes and a
  **Guest policy**: Children (not stated, Adults only, Children welcome),
  Plus-ones (not stated, By invitation, Welcome) and an optional note. The
  events table shows all three.
- **The events spreadsheet** gains five optional columns: **Run of Show** (one
  item per line, a 24-hour time then the name, `16:00 Tea is poured`),
  **Getting There**, **Children**, **Plus-Ones** and **Guest Policy Note**. A
  sheet without one of them leaves what each event already has; a blank cell
  clears it, and the preview warns, per event, before a save clears any of
  them. A line without a time or without a name is refused with its row
  named. Both re-importable downloads carry the columns, so do the restore
  points a revert reads, and the reporting `events.csv` gains them before
  Invited Guests.
- **Storage.** Migration `0092_event_run_of_show.sql` adds a
  `run_of_show_items` table (event, wedding, sort order, time, label; deleted
  with its event) and four nullable `events` columns: `getting_there`,
  `children_policy`, `plus_one_policy` and `guest_policy_note`. A run of show
  holds at most 40 items of at most 200 characters; the notes are capped at
  10,000 characters, as every other value. A save rewrites only the lists
  that changed.
- **The guest invite's details sheet** shows the guest policy last among the
  key facts, then the run of show in time order from the event's start, then
  About, Dress Code and Inspiration, then Getting there; each is hidden when
  empty. The policy is wording only: "Plus-ones welcome" is shown only to a
  household with a member invited to the event who may bring one, and to no
  other household; who may bring a plus-one is still each guest's own
  permission.
- The claim response and the organiser's `GET /events` carry the five fields;
  the public invite read does not. The guest site and the portal treat them as
  optional, so either can deploy before the API. An older API drops them from
  a save: deploy `cire-api` first.
- The end-to-end flow `cire-event-details` now also builds a run of show
  (moving an item from the keyboard), sets the notes and the policy, reverts a
  later save, round-trips the events sheet, and checks the guest sheet for two
  households: the organiser's preview, which may bring no plus-one, and one
  that may.
