---
"@shared/legal": minor
"@musubi/landing": patch
"@pulse/landing": patch
---

Publish no postal address on any legal page, so the draft banners come down.

`@shared/legal` drops `postalAddress` from `LegalEntity`, `LEGAL_ENTITY` and
`IDENTITY_FIELD_NAMES`. It was the one identity field still holding its
placeholder, so with it gone `LEGAL_DETAILS_PENDING` is false and no page shows
"Draft — this notice is not final" on its account. `draftPending` and
`isPlaceholder` stay, for any field a page adds later.

The privacy notices of `@musubi/landing` and `@pulse/landing` no longer print
`{{POSTAL_ADDRESS}}`: their contact line names the operator and its privacy
mailbox, and their "Last updated" date moves to 2026-11-27.
