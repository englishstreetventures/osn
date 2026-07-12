---
"@cire/api": patch
"@cire/organiser": patch
---

Round-trip CSV export (guest-event-editor E1): `GET
/api/organiser/weddings/:weddingId/export/{events,guests}.csv` serialise the
wedding's current events + guests in the import template schema, so a
download can be edited in any spreadsheet tool and re-uploaded through the
import (export → import is a tested fixpoint). Canonical header labels move
to `cire/api/src/lib/sheet-headers.ts`, shared by the parser and the new
`services/state-export.ts` serialiser. `?fidelity=full` appends the snapshot
ID/code columns the upcoming checkpoint writer needs; the parser now
accepts-and-ignores those columns. ImportPanel gains "Download current
events/guests" buttons.
