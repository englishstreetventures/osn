---
"@cire/api": patch
---

The invite image slot map is checked against the `wedding_invite_customisations` table at compile time: each slot may name only its own key, crop and phone-crop columns, and only ones the table has, so a wrong name fails `typecheck` instead of being dropped by Drizzle. The slot writes are built by assignment so the compiler checks each column. The `cire-assets` orphan reconciler and the wedding purge read every slot's key column from that map, and the reconciler reads only columns that hold an R2 key, by slot name, so a new slot's images are kept live and reaped with no edit to either.
