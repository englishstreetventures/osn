---
"@cire/organiser": patch
"@cire/api": patch
---

Cire editor E5: interactive guests editor UI (guest+event editor §8).

- `@cire/organiser`: a new **Guests → Edit** tab — a household-grouped, inline-
  editable list on top of a shared **draft store** (`lib/guest-event-draft.ts`):
  loads current server state into an id-stable SolidJS store, tracks dirtiness
  against the loaded baseline, and gives in-session **undo + discard** for free
  (pure client state, no server round-trips while editing). Edit surfaces: add
  household, add/rename guest (**id-preserving** so a rename is an UPDATE, not
  remove+create — no code re-mint / RSVP drop), nickname, delete guest/household,
  and a per-guest × per-event **attendance checkbox matrix**. New rows carry no
  id (the reconcile mints one + auto-mints the household claim code, exactly like
  the import — households are always coded); existing rows keep theirs.
- **Save flow**: a sticky unsaved-changes bar → Save posts the whole draft as
  **DesiredState JSON** to the merged E4 `changes/preview` (editor front door,
  `removeManual` implicit-true — the draft is the whole truth), a shared preview
  modal renders the diff + confirm-gated impact warnings, confirm hits
  `changes/apply` (409 surfaced as a re-preview prompt), then refetch + toast.
  Field-invalid drafts can't be submitted; validation errors render inline via a
  client mirror of the server's guest field rules (`lib/guest-validation.ts`,
  pointing at `cire/api/src/services/guest-event-validation.ts` as source of
  truth — the server stays authoritative). Events are carried through the draft
  UNCHANGED so a guests-only save preserves the schedule (id-matched ⇒ no-op).
- **Shared component**: `ImportPanel`'s plan/warnings rendering is extracted into
  `components/ChangePreview.tsx` (`PlanCounts` + the confirm-gated preview block),
  so the spreadsheet import and the editor save-flow render the same preview.
- `@cire/api`: additive, read-only — `getAllGuests` + `OrganiserGuestRow` now
  expose each guest's `nickname` (nullable) so the editor can display AND preserve
  it through a DesiredState round-trip (without it, an untouched nickname would be
  blanked on save). No schema/migration change; the `changes/*` pipeline is E4's.
