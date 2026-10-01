---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
---

An owner can delete a wedding, and any owner can restore it for 7 days.

`DELETE /api/organiser/weddings/:weddingId` with `{ "confirmSlug": "<slug>" }`
soft-deletes the wedding: migration `0077_wedding_soft_delete` adds
`weddings.deleted_at` and `deleted_by_osn_profile_id`, and from that moment the
wedding is answered as unknown on every guest, vendor and co-host path — its
invite, images, claim codes, guest sessions (refused, not revoked), registry,
vendor enquiries, digest and gift-summary mail. The delete is refused while an
upgrade or gift payment can still land (409 `purchase_in_flight`,
`gift_in_flight`) or a change is mid-apply (409 `change_in_progress`). A gift
holds the delete only while it has a Checkout session that can still be paid
(under a day old) or a completed checkout whose bank debit is still settling
(under a week); a pending gift that never got a session does not.
`POST /api/organiser/weddings/:weddingId/restore` undoes it inside the window
(409 `not_deleted`, `restore_window_passed`). The wedding list returns an
owner's restorable weddings in a separate `deleted` array. Stripe's webhooks
still settle into a deleted wedding, and an unmatched refund or dispute is now
logged and counted.

The daily cron purges a deleted wedding once its 7 days have passed — every
row by cascade and the sheet and image objects those rows name — at most three
a run, holding back any wedding with money still settling or a gift in
dispute. Migration `0078_child_key_indexes` indexes the four child columns
that cascade searches (`registry_claims.family_id`,
`registry_contributions.family_id`, `vendor_enquiries.vendor_id`,
`guest_account_links.wedding_id`), so a purge or a retention sweep reads
only its own wedding's rows instead of scanning each table.

The organiser portal adds a danger zone to Settings (typed-slug
confirmation), a "Recently deleted" section with Restore on the wedding list,
and drops a wedding another owner deleted from an open tab.
