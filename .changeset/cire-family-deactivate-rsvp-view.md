---
"@cire/api": patch
"@cire/db": patch
"@cire/organiser": patch
---

Two organiser-admin features for cire weddings: deactivate / reactivate a family
(cut off a withdrawn invite without losing data), and a read-only in-dashboard
RSVP view.

- `@cire/db`: new nullable `families.deactivated_at` (timestamp) + forward-only
  D1 migration `0024_family_deactivated.sql`. NULL = active (self-backfilling),
  so every existing family stays active until an organiser deactivates one.
- `@cire/api`: deactivating a family now rejects its claim code on the guest path
  (`claimService.lookup`) with the SAME generic invalid-credentials failure an
  unknown code returns, so a withdrawn code stops working without revealing it
  ever existed. New owner-OR-co-host (`weddingMember`) routes
  `POST /api/organiser/weddings/:weddingId/families/:familyId/{deactivate,reactivate}`
  → `familyDeactivateService` (scope-checks family ∈ wedding AND `kind='guest'` —
  a host-preview family can't be deactivated; on deactivate it atomically revokes
  the family's live sessions). The family/guests/RSVPs are never deleted, so
  reactivating restores the code with all its data. New owner-OR-co-host
  `GET /api/organiser/weddings/:weddingId/rsvps` (JSON, no-store) → a read-only
  RSVP view grouped by event (each event with its responded guests + a status
  tally), reusing the CSV export's wedding-scoped, host-excluded reads. The
  existing `rsvps.csv` export is unchanged.
- `@cire/organiser`: the Guests table mutes a deactivated household + labels it
  "Deactivated — code disabled" with a confirm-gated Deactivate / direct
  Reactivate toggle. A new read-only "RSVPs" dashboard tab shows, per event, the
  guests and their status (attending / declined / maybe) with counts + dietary
  notes. The CSV export stays on the Guests tab.
