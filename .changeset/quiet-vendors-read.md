---
"@cire/api": patch
---

Collapse the duplicate `directory_vendors` reads in enquiry creation.

`POST /enquiries` read the same listing row three times — in the route, in
`enquiryService.open`, and in `issueClaimForListing`. It is now read once in the
route as the union projection all three need and passed down.
`issueClaimForListing` keeps its own `ownerOrgId` gate on that row, so the
decision still lives where it did. `enquiries.quote()` builds its response from
the values it just wrote instead of re-reading after the `UPDATE`.
