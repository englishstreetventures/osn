---
---

RSVP CSV export for the cire organiser portal. An organiser (owner **or**
co-host) can download a CSV of every guest's RSVPs for a wedding.

Backend: new `GET /api/organiser/weddings/:weddingId/rsvps.csv`, gated by
`weddingMember()` (owner or co-host — the same gate as the `/guests` and
`/events` dashboard reads), returns a server-built `text/csv` download
(`Content-Disposition: attachment`, `Cache-Control: no-store` for the guest PII,
`X-Content-Type-Options: nosniff`). A new `rsvpExportService.build(weddingId)`
produces **one row per guest** — Family Code, Family Name, Guest First/Last
Name, **one column per event** (ordered by event start time), then **Dietary
Requirements**. Each event cell distinguishes four states: blank = not invited,
`No response` = invited but hasn't replied, and `Attending` / `Not attending` /
`Maybe` mapping the `rsvps.status` enum. Guests who haven't RSVP'd at all are
still included; host-kind families are excluded; rows are sorted alphabetically
by Family Code. The CSV serialiser neutralises spreadsheet formula-injection
(prefixes a `'` to any cell starting with `= + - @`) and RFC 4180-quotes fields.

Frontend: a "Download RSVPs (CSV)" button in `GuestTable.tsx` calls the endpoint
via `authFetch` and triggers a blob download (`cire-rsvps-<slug>.csv`). The
`downloadCsv` helper was extracted from `ImportPanel.tsx` into a shared
`lib/download.ts` (`downloadBlob` + `downloadCsv`), reused by both surfaces.
