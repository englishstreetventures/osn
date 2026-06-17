---
"@cire/api": minor
"@cire/db": minor
"@cire/organiser": minor
"@cire/web": minor
---

Add a "Preview invite" button to the cire organiser dashboard that opens the
guest invite pre-filled with a per-wedding host code, so the host can see every
event and detail exactly as a guest would.

- `@cire/db`: new `families.kind` column (`'guest' | 'host'`, default
  `'guest'`) plus a partial unique index `families_one_host_per_wedding`
  (`wedding_id WHERE kind = 'host'`) enforcing at most one host family per
  wedding. Migration `0010_family_kind.sql` — additive and self-backfilling
  (existing rows default to `guest`).
- `@cire/api`: new `hostCodeService.ensureForWedding` (Effect) that
  idempotently find-or-creates the synthetic host family + its single guest and
  (re-)links that guest to every event in the wedding — so the preview always
  reflects the current event list, including events added by a later import.
  New owner-gated `POST /api/organiser/weddings/:weddingId/preview-code`
  (behind `osnAuth` + `weddingOwner`; 403 not 401 on ownership mismatch, 404 on
  unknown wedding) returns the `HOST-*` claim code. Host families are excluded
  from the spreadsheet-import diff (a CSV re-import never removes or churns
  them) and are barred from submitting RSVPs (`POST /api/rsvp` → 403,
  preview-only). The claim response carries a new `preview` boolean. New
  `cire.host_code.ensured` counter + `cire.host_code.ensure` span.
- `@cire/organiser`: new `PreviewInviteButton` in the dashboard header — POSTs
  the preview-code endpoint, then opens the guest site at
  `?code=<host code>` in a new tab. New `PUBLIC_CIRE_WEB_URL` env var points at
  the guest invite origin.
- `@cire/web`: the guest invite auto-claims from a `?code=` deep-link (no
  retyping), shows a "Preview mode" banner, and disables the RSVP button when
  the claim is a host preview session.
