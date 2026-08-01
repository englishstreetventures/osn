---
"@cire/api": patch
"@cire/organiser": minor
---

Cire spreadsheet import: say what's actually wrong with the CSV.

A failed import rendered as the bare words "Malformed spreadsheet" — the same
message for fourteen genuinely different problems, with no hint of which of two
files to open, which row, or what to change. The API had already worked all of
that out; the portal was discarding it.

- `@cire/organiser`: new `lib/import-errors.ts` turns the structured 422 into a
  sentence that locates the problem and says how to fix it — e.g. "In your
  events sheet, row 4, column 2 — Start must look like 2026-11-14T15:00+11:00 …
  opening the file in Excel, Numbers or Sheets can silently rewrite that cell as
  something like 14/11/2026 15:00." Covers every `MalformedSpreadsheetReason`,
  missing/unmatched columns, the formula guard, 409 re-preview, 413 size and 402
  capacity, and falls back to the server's own text (then the status) for
  anything unrecognised, so a future server-side failure is never a blank box.
  `ImportPanel` uses it for both preview and apply, which previously threw away
  `reason`, `row`, `column` and `sheet` entirely.
- `@cire/api`: parse errors now carry `sheet` (`events` | `guests`), stamped by
  the parser that raised them, because "Malformed spreadsheet" with two files in
  flight doesn't say which one to fix. Preview and apply share one 422 body
  builder — previously preview omitted `column` and apply returned nothing but
  `error`, so the same bad upload reported differently depending on which verb
  hit it. `snippet` stays unreflected (untrusted cell content).
- `@cire/api`: a leading UTF-8 BOM is stripped before parsing. Excel, Numbers and
  Google Sheets all write one; left in, it became part of the first header cell,
  so a sheet plainly headed `Event Name` was rejected with "Missing required
  column: Event Name" — an error the organiser had no way to falsify, since the
  character is invisible in every editor they'd check with.
