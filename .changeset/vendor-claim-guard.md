---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
"@cire/vendor": patch
---

An organisation owns at most one directory listing: migration 0071 makes
`directory_vendors.owner_org_id` unique, and a claim into an org that already
owns a listing fails with 409 `org_has_listing` without spending the token.
A claim binds only a listing nobody owns and spends the listing's other live
tokens, and the claim preview is empty for a claimed listing. The claim link
reaches the vendor by email only; the organiser sees whether the invite was
sent, not the link.
