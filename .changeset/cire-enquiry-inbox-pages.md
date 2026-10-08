---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
"@cire/vendor": patch
---

Page both enquiry inboxes.

- `GET /api/organiser/weddings/:weddingId/enquiries` and `GET /api/vendor/enquiries`
  answer `{ enquiries, nextCursor }`: at most 50 a page, newest message first
  with the id breaking a tie, and `?cursor=` for the next page. A cursor the API
  did not write is a 400 `invalid_cursor`.
- The vendor inbox reads each listing the caller's organisations own as one arm
  of a `UNION ALL`, five arms to a statement, so each listing is read in index
  order and stops at a page and one row. Up to five organisations is one
  statement; above five a lookup comes first and reads at most 100 listings.
- Migration `0083_enquiry_inbox_keyset` widens `vendor_enquiries_wedding_last_msg_idx`
  to `(wedding_id, last_message_at, id)` and replaces `vendor_enquiries_directory_idx`
  with `vendor_enquiries_directory_last_msg_idx` on
  `(directory_vendor_id, last_message_at, id)`.
- The organiser and vendor portals load the inbox a page at a time behind a
  "Load more enquiries" button that keeps focus while loading, moves it to the
  first new row and announces the count. A failed next page clears the inbox.
  The vendor portal reads its loaded pages again on each return from a thread.
