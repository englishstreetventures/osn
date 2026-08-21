---
"@cire/invites": patch
"@cire/landing": patch
---

Gate each cire legal page's draft banner on the fields that page publishes.

The banner came from `LEGAL_DETAILS_PENDING`, which only covers the entity name,
the postal address and the contact email. `@cire/landing`'s terms, privacy notice
and refund policy all also publish `{{MERCHANT_OF_RECORD}}`, and the privacy
notice publishes `{{RETENTION}}` on top — so filling in the operator's name alone
would have removed the banner from three live pages that were still printing an
unfilled token to the reader.

Each page now calls `draftPending(...)` from `@shared/legal` with every field it
names beyond the shared identity set, so the banner cannot outlive a placeholder
the page actually renders.

`@cire/landing`'s test asserts exactly that, in place of the one it had: that
test said a page may ship `{{TOKEN}}` text only while a banner is present, but no
page has held a token in its own source since the identity moved into
`@shared/legal` — it had been passing on its empty half, and passed throughout
the bug above.
