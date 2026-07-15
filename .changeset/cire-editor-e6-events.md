---
"@cire/organiser": patch
---

Cire editor E6: interactive events editor UI + change history (guest+event
editor §8) — the FINAL slice, completing the E1–E6 editor chain.

- **Schedule → Edit tab** (`components/EventsEditor.tsx`, an editor-gated
  `schedule/edit` sub in `ModuleShell`/`dashboard-route`): a re-orderable event
  list on top of the SHARED E5 **draft store** (`lib/guest-event-draft.ts`),
  which E5 built to carry events through untouched — E6 now mutates its `events`
  slice. Add/edit an event via a **drawer form** (name, start/end + timezone,
  address, dress-code description, palette editor reusing **`ColorPicker`**,
  Pinterest/Maps URLs; date via the themed **`DatePicker`** + a time + UTC-offset
  composer, `lib/event-datetime.ts`); **delete with an impact confirm** (RSVPs +
  uploaded image dropped — surfaced as a confirm plus the server's confirm-gated
  preview warnings); **re-order** with up/down controls that rewrite `sortOrder`.
  Existing events keep their `id` (rename ⇒ diff UPDATE, never remove+create);
  new events omit it (the reconcile mints one). Guests ride along unchanged.
- **Save flow**: the same sticky unsaved-changes bar → Save posts the whole draft
  as **DesiredState JSON** to E4 `changes/preview` → the SHARED `ChangePreview`
  modal (reused, not forked) → `changes/apply` on confirm (409 surfaced as a
  re-preview prompt) → refetch + toast. Field-invalid drafts can't be submitted:
  `lib/guest-validation.ts` gains the **event field mirror** (required Event
  Name/Start/Timezone, ISO-8601-with-offset start/end, http(s)-only URLs, palette
  colours against the shared `@cire/theme` allow-list, length bounds, duplicate
  event-name rejection) — the server stays authoritative. End-before-Start is a
  non-blocking warning (sheet leniency), mirrored via a new `draftWarnings`.
- **`ImportHistory` → `ChangeHistory`** (`components/ChangeHistory.tsx`): the
  history list is rebranded and now labels each entry by `kind` — "Spreadsheet
  import" / "In-app edit" — reads `changes/list`, and offers **Revert** only on
  applied entries that still have a usable before-image (`revertable`); an entry
  whose restore point aged out (E3 prune-beyond-10) shows a non-revertable note.
  Revert posts to `changes/revert`. `ImportPanel`'s explainer copy disambiguates
  the re-importable guest list from the (read-only) RSVP report.
- Frontend-only: no api/db/schema change (the E4 `changes/*` pipeline is
  complete). Adds `@cire/theme` as an organiser dependency for the shared
  CSS-colour allow-list. Tests: event drawer editing, reorder, inline validation
  + warnings, the datetime composer round-trip, preview→modal→apply→toast + 409,
  delete-confirm, and ChangeHistory kind labels + revertable/aged-out revert
  (happy-dom).
