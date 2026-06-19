---
"@cire/api": minor
"@cire/db": minor
"@cire/organiser": minor
---

Add a reliable **"Opened"** status for each guest household, driven by an ACTUAL
family-code claim, to replace reliance on the false-positive-prone **"Sent"**
status (which only means the organiser clicked "Copy message"). The organiser
sees an "Opened" badge in the Guests tab the next time they look — a persisted
dashboard status, not a push/email alert.

Data model: a single nullable `families.first_opened_at` column (migration
`0020_family_first_opened.sql`, an additive ADD COLUMN), sibling to
`code_shared_at`. NULL = no guest has opened the invite on the family's CURRENT
code. `schema.ts`, the `setup.ts` + `schema.test.ts` test DDL mirrors, and
migration 0020 are mutually consistent (a fresh local D1 applies 0001..0020
cleanly).

- `@cire/db`: migration `0020_family_first_opened.sql` + the `firstOpenedAt`
  column on `families`.
- `@cire/api`: `claimService.lookup` records the first open on a successful
  guest claim. The write is **idempotent** — a guarded `UPDATE ... WHERE id = ?
  AND first_opened_at IS NULL` records only the FIRST open and never overwrites,
  so it reflects first contact and avoids a write on every re-claim / page load
  (also safe under concurrent claims of the same code). It is **best-effort** —
  a write failure is logged (`Effect.logError`, familyId only, no
  publicId/code/PII) and swallowed, so the guest still gets their invite.
  **Host-preview claims (`kind === "host"`, the organiser's own preview) are
  excluded** so opening the preview never counts. A new bounded-cardinality
  `cire.invite.opened` counter (`metricInviteOpened("ok" | "error")`) mirrors
  `metricFamilyCodeShared`. `getAllGuests` (+ the `OrganiserGuestRow` schema)
  now returns `firstOpenedAt` as epoch-ms or null, mapped like `codeSharedAt`.
  Remint coherence: the bulk re-mint clears `first_opened_at` back to NULL
  alongside `code_shared_at` (the rotated code has never been opened).
- `@cire/organiser`: the Guests table renders an **"Opened"** badge (gold/success
  accent) that takes **precedence** over "Sent" — `firstOpenedAt != null` ⇒
  "Opened" (with an honest tooltip naming the open date); else if shared ⇒ the
  soft secondary "Sent" badge (kept, with a clarified "you copied the message"
  tooltip); else nothing. "Opened" comes only from server data (no optimistic
  flip); the optimistic `sharedNow` behaviour for "Sent" is unchanged. The remint
  "already sent out" warning now treats an OPENED family as out-there too —
  counting a family when `codeSharedAt != null` OR `firstOpenedAt != null`.

Ops note: this is additive and pre-launch — every existing family row defaults to
NULL, so no household shows "Opened" until a real guest claims its code.
