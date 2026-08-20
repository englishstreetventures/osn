---
"@osn/landing": patch
"@pulse/landing": patch
---

One source of truth for the operator's published identity, and the missing terms
sections.

Every legal page carried its own `{{LEGAL_ENTITY}}`, `{{CONTACT_EMAIL}}`,
`{{POSTAL_ADDRESS}}`, `{{REGULATOR}}`, `{{RETENTION}}` and
`{{MERCHANT_OF_RECORD}}` placeholder plus a hand-written "Draft — replace every
highlighted value" banner. All of it was live in production, because filling the
values in meant eight coordinated edits by someone holding all of them. The new
`@shared/legal` package holds them once; the draft banner is derived from whether
they are still placeholders, so a page cannot be left half-published and the
banner cannot outlive the values.

The two marketing terms pages had no governing-law clause at all, no consumer-law
carve-out, and no changes clause. They have all three now, and their liability
paragraph no longer reads as excluding guarantees the Australian Consumer Law does
not allow to be excluded. Governing law is stated at country level on all four
terms pages.

`@pulse/landing`'s privacy notice disclosed "basic, privacy-respecting analytics"
that the package does not run. Describing collection that does not happen is still
a wrong notice; the line now says what the static host actually keeps.
