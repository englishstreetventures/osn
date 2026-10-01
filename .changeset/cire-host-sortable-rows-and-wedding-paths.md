---
"@cire/host": patch
---

Organiser portal: sortable rows that survive a reorder, drag styling that stops waking every row, and one encoded path for every wedding API call.

- The gift list, checklist and budget key their rows by id. A delete leaves a gap in the stored order, so the next move stored a new order for every row past the gap and rebuilt each of them — up to 500 on a full gift list, and an open inline editor past the gap lost its caret. A row now keeps its DOM when only its stored order changed, and is rebuilt, as before, when anything else about it did.
- The five sortable row templates read the drag state's new `dragging()` rather than `active()`, so their transition class is recomputed when a drag starts and ends rather than on every slot crossed.
- Every `/api/organiser/weddings/<id>` path goes through `weddingPath`, which percent-encodes the id, so an id holding `/`, `?` or `#` can no longer form a different path. Item, task, payment, vendor, household, guest, event and listing ids later in the path are encoded too. A wedding id of `.` or `..` read from the dashboard hash or the upgrade return query is refused, since the URL parser resolves dot segments whatever the encoding. This is hardening: the dashboard already mounts only a wedding from the server's own list.
