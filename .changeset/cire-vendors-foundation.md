---
---

Add the Vendors Slice 1 PR A foundation to cire: four new D1 tables (`directory_vendors`, `directory_vendor_categories`, `vendors`, `vendor_claims`, migration 0040); wedding-scoped organiser Vendor CRM (`vendorsService` + `/api/organiser/weddings/:weddingId/vendors` routes + `VendorsView` module); global directory listing + email-verification claim backend (`directoryService` — organiser seeds a listing and the system mints a claim token, returned to the organiser + sent via fail-soft email; vendor consumes via `/api/vendor/claim` binding the listing to their OSN org); vendor-portal routes `/api/vendor/*` gated by `vendorOrgMember()` (OSN org membership resolved over ARC `org:read` scope).
