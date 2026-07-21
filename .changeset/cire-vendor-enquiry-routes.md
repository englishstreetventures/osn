---
"@cire/api": patch
---

Add vendor-side enquiry routes + claim-flush wiring (Vendors S4 PR B).

New `/api/vendor/enquiries` surface (osnAuth-gated) for the vendor operator:
list enquiries across their claimed listings, read a thread, reply, and attach a
structured quote (`{ amountMinor, note? }` → mirrors `vendors.quoted_minor` +
`vendor_enquiries.quoted_minor`, status `quoted`, Zap message + couple email).
The per-enquiry org gate resolves the owning org from the enquiry's listing and
404s on a cross-tenant id (no enumeration); reply/quote run behind the per-user
enquiry limiter.

Central fix: `directoryService.consumeClaim(token, orgId, claimingProfileId)`
now records `directory_vendors.claimed_by_profile_id` in the same UPDATE that
binds `owner_org_id`, so a production-claimed listing reads as CLAIMED by the
enquiry service. After a successful claim, the vendor-portal consume handler
flushes any enquiries buffered against the listing via
`enquiryService.onVendorClaimed` (best-effort).

Perf/security fix pass (prep-pr): scope the `/api/vendor/enquiries` list to the
caller's own org(s) before the scan (reuses the `profile-orgs` ARC resolver,
indexed `owner_org_id IN (...)` predicate — removes the cross-tenant full-table
scan + unbounded ARC fan-out; fail-closed to an empty list when the caller has
no orgs), cap `getMessages` at `{ limit: 50 }` (Workers 6MB wall), and flush
buffered enquiries on claim with bounded concurrency (`Effect.all({ concurrency:
5 })`) instead of a serial loop.
