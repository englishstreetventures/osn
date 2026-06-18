# Cire organiser: code-style onboarding + remint + copy-message — design

Date: 2026-06-19
Branch: `feat/cire-wedding-onboarding-codes`
Scope: `cire/db`, `cire/api`, `cire/organiser` (all `@cire/*` — version-less, empty changeset)

## Goal

Give a non-technical organiser control over the family **claim-code style** and a
safe way to share codes:

1. Pick the code style (`simple` vs `secure`) when **creating** a wedding.
2. **Re-mint** all of a wedding's family codes onto a different style.
3. **Warn** before reminting if any family's code was already shared (reminting
   invalidates shared codes → guest links break).
4. Per-family **"Copy message"** button — copies a ready-to-send invite message
   (link + that family's code) and marks the family as "shared".

## Settled design decisions (the brainstorm)

### Shared-tracking mechanism — `families.code_shared_at`

There is no sent/shared tracking today. Add a nullable timestamp column
`families.code_shared_at` (integer, ms epoch via Drizzle `timestamp` mode).

- The per-family **Copy-message** button (part 4) POSTs `mark-shared`, which sets
  `code_shared_at = now`. Best-effort: the copy never blocks on it.
- Reminting **clears** `code_shared_at` back to `NULL` for every rotated family —
  the old (shared) code is dead, so the new code starts un-shared. This keeps the
  warning honest after a remint.
- The remint **warning** counts families with `code_shared_at IS NOT NULL`. The
  count is read from the guest list (each guest row already carries `publicId` +
  `familyName`; we add `codeSharedAt`), so the dashboard can show "N families have
  already been sent their codes" without a new endpoint.

Rationale: matches the existing nullable-timestamp idiom in the schema
(`dietary_consent_at`, `applied_at`, `reverted_at`); forward-only (pure ADD COLUMN,
no drop); no new table/join. Alternative considered — a separate `share_events`
audit table — rejected as YAGNI for a single boolean-ish "has this been sent" signal.

### Remint flow — `POST /weddings/:weddingId/remint`

- Body `{ codeStyle: "simple" | "secure" }`, validated server-side against the enum.
- Service `remintWeddingCodes(weddingId, codeStyle)`:
  1. Update `weddings.code_style = codeStyle`.
  2. For every **guest** family (kind != 'host') under the wedding: mint a fresh
     `generateFamilyCode(familyName, codeStyle)`, set `public_id`, clear
     `code_shared_at`.
  3. Delete every session for those families (reuse the regenerate semantics —
     leaked/old codes + sessions die in the same commit).
  - All in **one atomic D1 batch** (same `commitBatch` helper as regenerate).
  - Returns `{ codeStyle, reminted: <count> }`.
- Gated by `weddingOwner()` (owner-only). Host preview family is left untouched
  (its `HOST-*` code is not a guest claim code).
- The endpoint does **not** block on shared state — the owner has already been
  warned in the UI and explicitly confirmed. The warning is advisory; the action
  is authoritative.
- Per-IP rate limiter (owner-gated already; caps the bulk-write amplifier), same
  pattern as preview/create.

### Create-wedding style picker

- `CreateWeddingBody` accepts optional `codeStyle` (enum, default `secure`).
- `weddingsService.createForOwner(osnProfileId, displayName, codeStyle)` threads it
  into the insert (replacing the hardcoded `"secure"`).
- UI: a two-option radio/segmented control in `CreateWeddingForm`, friendly labels:
  - **Simple** — "Short, friendly codes — easy to read aloud or type."
  - **Secure** — "Longer codes — harder to guess. Recommended." (default)

### Copy-message + guest URL

- Guest site URL = `CIRE_WEB_URL` (`PUBLIC_CIRE_WEB_URL`, already known to the
  organiser build via `src/lib/osn.ts`).
- Message copy (single line, no PII beyond family name's own code + public URL):

  > You're invited to {weddingName}! View your invitation and RSVP at
  > {guestSiteUrl} — your family code is {CODE}.

- Client-side `navigator.clipboard.writeText`; falls back to a hidden-textarea
  `execCommand('copy')` then to showing the text for manual copy when the
  clipboard API is unavailable (non-secure context).
- On a successful copy, fire a best-effort `POST mark-shared`; do not block the
  copy or surface its failure as a copy error.

## Endpoints added

| Method | Path | Auth | Body | Result |
|---|---|---|---|---|
| POST | `/api/organiser/weddings/:weddingId/remint` | `weddingOwner` | `{ codeStyle }` | `{ codeStyle, reminted }` |
| POST | `/api/organiser/weddings/:weddingId/families/:familyId/mark-shared` | `weddingOwner` | — | `{ familyId, codeSharedAt }` |

`POST /api/organiser/weddings` gains optional `codeStyle`.
`GET .../guests` rows gain `codeSharedAt: number \| null`.

## UI placement

- **CreateWeddingForm.tsx** — add the style picker.
- **GuestTable.tsx** — per-family "Copy message" button + a "Sent" indicator when
  `codeSharedAt` is set. Needs the wedding's `displayName` (for the message) and
  `slug` is not needed (guest claims by code at the web root). Pass `weddingName`
  down.
- **RemintPanel.tsx** (new) on a new **Codes** tab (or within an existing
  settings-ish area) in **DashboardTabs.tsx** — current style, a style switch, the
  shared-count warning, a confirm step, and the remint action.

## Data flow / safety

- Remint is destructive (rotates every code, kills sessions). The batch is atomic;
  on bun:sqlite (tests) it degrades to sequential, same as regenerate.
- All new endpoints go through `weddingOwner()` — a co-host/stranger gets 403; the
  service re-derives scope from `:weddingId`.
- `codeStyle` validated against the `["simple","secure"]` enum server-side
  (Effect Schema literal union) → 400 on anything else.

## Migration + lockstep

- New migration `cire/db/migrations/0016_family_code_shared_at.sql`:
  `ALTER TABLE families ADD COLUMN code_shared_at integer;` (nullable, no default —
  forward-only, applies cleanly on D1).
- **LOCKSTEP CONTRACT** (3 places must change together):
  1. `cire/db/src/schema.ts` — add `codeSharedAt` to `families`.
  2. `cire/api/src/db/setup.ts` `DDL` — add `code_shared_at` to the `families` table.
  3. `cire/api/src/db/schema.test.ts` `DDL` — same.

## Tests

- **cire/db**: migration applies cleanly (schema test mirror).
- **cire/api** (bun:test, `createApp(db)`, `appRequest`, `:memory:`):
  - create with each style persists `code_style`.
  - remint changes `weddings.code_style`, rotates **all** guest family codes onto
    the new style, clears `code_shared_at`, revokes sessions, leaves host family
    untouched; non-owner 403; bad codeStyle 400; unknown wedding 404.
  - mark-shared sets the timestamp; non-owner 403; cross-tenant family 404.
  - guest rows expose `codeSharedAt`.
- **cire/organiser** (vitest + happy-dom):
  - style picker renders + submits the chosen style.
  - copy-message writes the expected text to a mocked clipboard + fires mark-shared.
  - remint panel shows the shared-count warning + requires confirm.

## Changeset

All touched packages are `@cire/*` (version-less / ignored) → **empty changeset**.
A `cire/db` migration is fine.
