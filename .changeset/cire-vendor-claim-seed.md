---
"@cire/vendor": patch
---

The claim-to-editor handoff no longer leaves a copy of the claimed listing in
`sessionStorage` until an editor opens. The claim page still writes it just
before its full-page redirect to the dashboard, but the dashboard now takes it
off storage as the page loads (`drainClaimedListing`, called at the top of
`VendorApp`) and holds it in page memory for the first editor that asks
(`takeSeededListing`, which no longer reads storage). Before, the copy, with the
vendor's email, phone, location and price band, stayed in the tab until the
vendor picked an organisation, and for the tab's whole life if they never did.

One visible difference: if the vendor lands on the dashboard signed out, the
held copy is lost on the redirect to sign in, and the editor fetches the
listing instead of reusing it.
