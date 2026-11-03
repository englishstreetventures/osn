---
"@pulse/api": patch
---

Event status transitions now write only while the row still has the status they were derived from, so a cancel or early close committed between a read and its transition write is no longer overwritten.
