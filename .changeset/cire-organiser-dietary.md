---
"@cire/api": patch
"@cire/host": patch
"@cire/db": patch
"@cire/dietary": patch
---

An organiser's status change keeps every guest's dietary answer, and an organiser can record a plus-one's dietary requirements under an attestation of its own.

- `@cire/dietary`: adds `ORGANISER_PLUS_ONE_DIETARY_ATTESTATION` (version `organiser-plus-one-2026-10-01`), the organiser's wording for a plus-one.
- `@cire/api`: `PUT …/guests/:guestId/rsvps/:eventId` treats a body with neither `dietary` nor `dietaryPresets` as status-only for every guest, keeping the stored dietary answer, its consent record and `consent_source`. A plus-one's dietary data is stored under the new attestation version and the plus-one's current name (`dietaryAttestedName`); the guest wording on a plus-one gets 422 `plus_one_dietary_unavailable`, the plus-one wording on anyone else 422 `dietary_attestation_mismatch`, a stale name 409 `plus_one_changed`.
- `@cire/host`: the RSVP editor opens the attestation box unticked, shows it only once the dietary answer is edited, and sends `{ status }` when it is not. A plus-one's reply offers the dietary fields under the plus-one wording.
- `@cire/db`: the `consent_source` column comment.
