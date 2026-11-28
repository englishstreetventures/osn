---
"@shared/legal": minor
"@musubi/landing": patch
"@pulse/landing": patch
---

Publish no postal address on any legal page, so the draft banners come down.

`@shared/legal` drops `postalAddress` from `LegalEntity`, `LEGAL_ENTITY` and
`IDENTITY_FIELD_NAMES`. It was the one identity field still holding its
placeholder, so with it gone `LEGAL_DETAILS_PENDING` is false and no page shows
"Draft — this notice is not final" on its account. The identity check is now
`identityPending(entity)`, which `LEGAL_DETAILS_PENDING` applies to the
published record. `draftPending` and `isPlaceholder` stay, for any field a page
adds later.

The privacy notices of `@musubi/landing` and `@pulse/landing` print no postal
address: their contact line names the operator and its privacy
mailbox, and their "Last updated" date moves to 2026-11-27. On both sites'
privacy notice and terms, each mailbox is a `mailto:` link, and the back link
keeps 1.5rem below it, so the title sits the same distance down with or
without a draft banner.
