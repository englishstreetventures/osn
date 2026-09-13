---
"@cire/api": patch
"@cire/host": patch
---

C-L1 (cire) — the gift log had no read path off the platform. The portal shows
it a page at a time and the retention sweep folds it into totals after a year,
so a couple who wanted their own copy of who gave what had no way to take one.

Adds `GET /api/organiser/weddings/:weddingId/gifts.csv` alongside the existing
rsvps/guests/events exports, and a "Download gifts (CSV)" button on the host's
gift log. The export reads the same two tables as the portal's log, with the
same `failed`-contribution exclusion and no host-family exclusion, so the file
contains exactly what the organiser can already see and nothing more.

Amounts print as bare major-unit decimals with the currency in its own column —
a spreadsheet can sum a number, not "$12.50" — and the FX columns carry the
primary-currency equivalent snapshotted at charge time. That needed a
minor-to-major conversion on the API side, which had none, so
`cire/api/src/lib/money.ts` reads the exponent off `Intl` rather than dividing
by 100: JPY has no minor unit and KWD has three, and a fixed 100 mis-states
both by 100x.

One export is capped at 5,000 rows. An export cannot page, so the cap is set
well above any real wedding, and a read that reaches it logs a warning rather
than silently dropping rows.
