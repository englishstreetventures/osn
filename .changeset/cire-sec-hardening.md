---
"@cire/api": patch
---

Security-hardening pass on cire/api (six open items from `cire/wiki/todo/security.md`).

**OBS-S-L2 — stop logging the raw error message.** The root `onError` boundary in
`src/app.ts` logged `error.message`, but the redacting logger scrubs by object KEY,
not by substring inside a string value — so a rare unhandled message echoing guest
input or a D1 internal (e.g. `no such table: families`) landed verbatim in operator
logs. It now logs only non-sensitive identifiers: the Elysia `code`, the error
`name`, and (for `Data.TaggedError` defects) the tagged `_tag` — never the
free-form `.message`. The response body stays the generic `{ error: "Internal
error" }`. A new `app.test.ts` test asserts the structured line carries the error
name but not the raw SQLite message.

**AL-S-L2 — collapse the account-link 409 oracle.** `POST /api/account/link`
distinguished a `409 already_linked` from a `409 account_already_in_family`, the
latter revealing that some OSN account is already seated elsewhere in the caller's
own household (a membership oracle). Both conflicting UNIQUE indexes (`guest_id`
and `(family_id, osn_account_id)`) now map to a single opaque
`AccountLinkConflict.reason = "already_linked"` in `services/account-link.ts`, so
the two cases are indistinguishable end-to-end (tag → status → body). Service +
route tests updated.

**MalformedSpreadsheet reason lockdown.** `MalformedSpreadsheet.reason` is now the
closed union `MalformedSpreadsheetReason` (the exact static literals) in
`services/spreadsheet.ts`, with a doc comment stating the constraint: `reason` must
only ever carry static literals, never interpolated cell contents (which would
reflect attacker-controlled spreadsheet data into the 422 body). `CsvParseResult`
narrowed to match. A future contributor passing an interpolated string is now a
compile error. Audited every construction site — all static today (the row/column
NUMBERS are fine; no cell CONTENTS interpolated).

**No-raw-SQL audit (confirm-only, clean).** Confirmed all D1 access goes through
Drizzle's query builder. The sole `` sql` `` use is a parameterised
`` sql`max(${events.date})` `` (column placeholder, no user data); `.run()`/`.all()`
are query-builder terminals; the only `.exec(...)` is the static test-DB DDL. No
raw or interpolated SQL.

**Invite-token-in-URL audit (confirm-only, clean).** Confirmed no internal DB id
reaches a URL on guest surfaces — claims use the family `publicId` code and host
preview uses the `HOST-*` code; `slug` is the public identifier. Internal ids
(`:weddingId`/`:eventId`/`:familyId`) appear only on auth-gated `/api/organiser/*`
routes; `:guestId` on the account-link DELETE is scoped to the caller's own
session+household and never shared.

**CI guard — placeholder D1 `database_id`.** Added `scripts/check-d1-database-id.sh`
(grep-only) which fails if `cire/api/wrangler.toml` carries the placeholder
sentinel, an empty id, or any `placeholder`-flavoured id, with an actionable
message. Wired as the first step of the `deploy-cire-api` job in
`.github/workflows/deploy.yml`, before the D1 migrate + Worker deploy.
