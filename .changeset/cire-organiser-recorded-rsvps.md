---
"@cire/api": minor
"@cire/db": minor
"@cire/organiser": minor
---

Organiser-recorded RSVPs (phone/paper, Art. 9 consent-attested).

An organiser (owner or editor co-host) can now record a guest's RSVP on their
behalf — for replies phoned or posted in — via
`PUT /api/organiser/weddings/:weddingId/guests/:guestId/rsvps/:eventId`
(`weddingEditor()`-gated; viewers get 403 `read_only_role`). The write lands in
the SAME `rsvps` table the guest invite writes to, upserting on the existing
`(guest_id, event_id)` unique key, so last-writer-wins: an organiser reply
visibly overwrites a prior guest answer and vice-versa.

**DB (`@cire/db`)** — additive migration `0037_rsvp_consent_source.sql` adds
`rsvps.consent_source` (`'guest' | 'organiser_attested'`, NOT NULL DEFAULT
`'guest'`), back-filling every legacy row as `'guest'` (the guest form was the
only writer before this endpoint). Pure `ADD COLUMN` — no table rebuild
(`rsvps`' FKs are on `guest_id`/`event_id`, the new column touches no
index/constraint). Mirrored across all three DDL surfaces (migration, `setup.ts`
test DDL, Drizzle `schema.ts`); T-S1 lockstep green at 0037.

**Writer-attribution design** — ONE column (`consent_source`) carries BOTH the
writer attribution AND the Art. 9 consent basis. In this domain the writer and
the consent-attester are always the same principal (a guest attests their own
consent; an organiser attests the guest's consent on their behalf), so a
separate `recorded_by` column would be 1:1 redundant with `consent_source`.

**API (`@cire/api`)** — new `organiser-rsvp` route + service. The service
re-validates, in wedding scope, that the guest belongs to a `kind='guest'`
family under the wedding, the event belongs to the wedding, and the
`(guest, event)` pair is a real invitation (`guest_events`), so a cross-tenant
write is impossible and an organiser can't RSVP a guest to an event they aren't
invited to (409). Dietary free-text keeps its Art. 9(2)(a) story: the same
500-char cap + consent gate as the guest path — the organiser's attestation is
the consent, the API 422s a non-empty dietary without it, and the same
`dietary_consent_at`/`dietary_consent_version` record is stamped, alongside
`consent_source='organiser_attested'`. The RSVP CSV report gained a "Recorded
By" column and the in-dashboard RSVP view now carries `consentSource` per reply
plus an `unresponded` list of invited-but-unreplied guests. The
`cire.rsvp.upserted` metric gained a bounded `source` (`guest`/`organiser`)
attribute.

**Organiser portal (`@cire/organiser`)** — the RSVP view (`RsvpView`) lets an
editor record/update a guest's RSVP per event: status + optional dietary gated
by an explicit "I confirm the guest consented…" attestation checkbox (mirroring
the guest consent UX). Organiser-entered replies are badged distinctly from
guest-submitted ones; viewers stay read-only.

Compliance: the DPIA, data-map, and retention pages were updated for the
organiser-attested consent variant and the new `consent_source` field (no new
subprocessor, no new personal-data class — a bounded consent/writer
discriminator).
