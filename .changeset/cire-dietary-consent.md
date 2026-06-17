---
"@cire/api": minor
"@cire/db": minor
"@cire/web": minor
---

Dietary RSVP field now captures explicit Art. 9(2)(a) consent (DPIA C-H2).

The free-text `rsvps.dietary` field is special-category data, so it now
requires an explicit, unticked-by-default opt-in and a stored consent
record. `rsvps` gains `dietary_consent_at` + `dietary_consent_version`
columns (migration 0011); the RSVP API rejects (422) any non-empty
dietary submitted without consent and stamps the consent timestamp +
version when given; the guest RSVP modal shows a consent checkbox once
dietary text is entered, gates submit on it, and links to the `/privacy`
notice.
