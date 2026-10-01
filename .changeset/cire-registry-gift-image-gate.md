---
"@cire/api": patch
"@cire/db": patch
---

Close a gift's image when the gift goes, and make the guest registry's reads
cheaper. The public gift-image route now checks that an item of the wedding
still names the image, so deleting a gift or saving a new picture over it stops
its old image URL at once, the Worker cache included; browsers let go within
the hour. The guest gate reads the slug, entitlement, settings and that item in
one D1 statement instead of three, backed by a new `(wedding_id, image_key)`
index on `registry_items`. A gift image the browser already holds is
revalidated with a 304 after the gate, with no cache lookup, R2 read or
transform. The portal's gift log reads each page as one `UNION ALL`, so the
deepest page returns 51 rows instead of up to 551 from each table.
