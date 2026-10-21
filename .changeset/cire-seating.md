---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
"@cire/landing": patch
"@cire/ui": patch
---

Seating chart: tables per event and which guest sits at which, with one seat
per guest per event enforced by the database (migration 0088). A Gold module
in the host portal: seat a guest by dragging them onto a table or by choosing
the table from their menu, see who declined, said maybe, has not replied or
was withdrawn, print the chart, and download `seating.csv` (owner). The
import and editor preview warns when a change clears seats or tables, and the
apply and revert of a change no longer repeat the preview's warning reads, and
their summaries no longer carry a warnings list. The
guest and host privacy notices name seat assignments among the data held.
