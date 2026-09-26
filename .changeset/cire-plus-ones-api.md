---
"@cire/db": minor
"@cire/api": minor
"@cire/host": patch
---

Store plus-ones and serve them through the cire API. A plus-one is an
ordinary `guests` row that points at the guest who brought them
(`plus_one_of_guest_id`, migration 0066), and `plus_one_allowed` holds an
editor's permission. Editors set it per guest or per household; the household
names, renames and removes its plus-one on the invite until the RSVP deadline,
behind a per-IP limiter, and an editor can correct a plus-one's name at any time.
A plus-one's reply is stamped `consent_source = 'inviter_attested'`, and the API
refuses dietary data on it, on the organiser's recording route as well, until
the invite carries wording for that attestation. The change pipeline never matches a plus-one: they follow their
inviter, and the organiser's guest editor leaves them out of its draft.
