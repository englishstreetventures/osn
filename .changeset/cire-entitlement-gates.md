---
"@cire/api": patch
---

Close the entitlement gaps on the organiser API and make the gate wiring
something CI checks.

- **Enquiries need `vendors`.** The couple's enquiry routes
  (`/api/organiser/weddings/:weddingId/enquiries/*`) now answer 402
  `payment_required` for a wedding without the `vendors` entitlement, like the
  vendor CRM and directory routes beside them. The gate sits after the role
  gate and before the write limiter, so an unentitled wedding cannot send a
  vendor email, open a chat or spend limiter budget. The portal already hid
  these routes from such a wedding; this is the answer to a direct API call.
- **The owner gate folds the entitlement check too.** `weddingOwner(db, key)`
  takes the same optional key as `weddingMember` and `weddingEditor`, adding the
  presence check to its own query. The Stripe onboarding routes pass `registry`,
  so the owner's request costs one query instead of two. A fault confined to
  `wedding_entitlements` falls back to the plain owner query and a scoped 402,
  never a 500. The `EXISTS` column both folds use is now one function,
  `entitlementPresent()`.
- **A test holds the pairing.** `tests/routes/entitlement-gate-pairing.test.ts`
  parses every file under `src/` and fails when a `weddingEntitlement(db, key)`
  mount is not directly behind a folding role gate with the same key, or when a
  role gate passes a key nothing reads. It also pins which files mount the gate.
- **The gift-log export stays ungated, on purpose.** `gifts.csv` is the couple's
  own record and must stay exportable whether or not the wedding holds
  `registry`. The route now says so, and a named test fails if a plain gate is
  added.
