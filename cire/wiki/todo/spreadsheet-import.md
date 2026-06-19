---
title: "Cire TODO — organiser spreadsheet import"
tags: [todo, organiser, spreadsheet]
related:
  - "[[index]]"
  - "[[api]]"
  - "[[db]]"
last-reviewed: 2026-06-19
---

# Organiser Spreadsheet Import

Source spreadsheet has these columns: `Family ID, Guest First Name, Guest Last Name, Family Name, Catholic Wedding, Hindu Wedding, Reception, Mehndi`. Row grouping is by `Family Name`; only the last row of each family carries a Family ID in the source sheet (we ignore that — Cire generates its own `publicId`). Each guest row has booleans per event.

## Spreadsheet ingestion (cire/api)

- [x] `services/spreadsheet.ts` — `parseEventsCsv` / `parseGuestsCsv` (hand-rolled RFC 4180); rejects formula-injection cells (cells starting with `=`, `+`, `-`, `@`) (PR-C; trim-resilient as of PR-C review)
- [x] **Location + Start are hard-required per event** (`feat/invite-conditional-segments`) — `REQUIRED_EVENT_COLUMNS` now includes `Location` (alongside Event Name / Start / End / Timezone). A missing Location **header** ⇒ `MissingRequiredColumn`; an empty/whitespace-only Location **cell** in any data row ⇒ `MalformedSpreadsheet` (`"Location is required"`, 1-indexed row/column) — same clear, row-scoped error shape as the existing Start/End/Timezone checks, surfaced in `ImportPanel.tsx`. The organiser template/help mirror (`import-templates.ts` `EVENT_REQUIRED_HEADERS`) is kept in lockstep by `import-templates.test.ts`. See `[[api]]` + `[[invite-builder]]` (Required event fields).
- [x] `services/import.ts` — `diffAgainstDb(parsed)` returns `ImportPlan` (creates / updates / removes per family + per guest); `applyImport(plan)` executes in dependency order with per-statement chunking (PR-C)
- [x] **`diffAgainstDb` wedding-scoping** — `diffAgainstDb(parsedEvents, parsedFamilies, weddingId)` now scopes every read to `weddingId`: `events` / `families` filter on the column directly, `guests` / `guest_events` join through `families` (neither carries `wedding_id`). The link-table join is load-bearing — a naive per-table `WHERE` couldn't scope `guest_events` and would read a second wedding's links as removals. The interim `MultiWeddingImportUnsupported` fail-closed tripwire is removed. Covered by the multi-tenant isolation tests in `services/import.test.ts` + `routes/organiser-import.test.ts`.
- [x] `services/r2-imports.ts` — R2Service Context tag + `storeUpload` / `fetchUpload` (PR-C)
- [x] `services/revert.ts` — `revertImport` re-fetches prior CSVs from R2, re-parses, re-diffs, re-applies (PR-C)
- [x] `schemas/import.ts` — Effect Schema for `ParsedEvent`, `ParsedFamily`, `ImportPlan`, request/response shapes (PR-C)
- [x] Plan preserves `publicId` for matched families (case+whitespace-insensitive on `family_name`); only mints new IDs for brand-new families (PR-C)
- [x] Per-guest event invitations from boolean columns drive `guestEvents` rows (PR-C)
- [ ] When the source sheet adds a stable `Guest ID` column, populate `guests.externalId` from it (already in schema as of PR-A)

## Organiser portal (cire/organiser + cire/api)

- [x] **Co-hosts can use the import** — the `/import/{preview,apply,revert,list}` routes moved from `weddingOwner()` to `weddingMember()`, so a wedding's co-hosts get **full** import access (preview AND apply — they're trusted co-organisers, and the spreadsheet is the primary way guests + events get populated), not view-only. UI: `OrganiserApp.tsx` no longer gates `<ImportPanel>` on `isOwner`. Owner-only stays narrow: re-mint / regenerate codes, host add/remove, wedding deletion. `weddingMember()` fails closed if the ARC/host lookup is down. See `[[wiki/systems/cire-auth]]` (root, capability matrix) + `[[api]]`.
- [x] Organiser auth model — resolved in the OSN merge: OSN passkey sign-in + `osnAuth()` JWT verification, no separate `organisers` table or magic link (see [[deferred]] resolved row and `[[wiki/systems/cire-auth]]` in the root OSN wiki)
- [x] Auth middleware that rejects guest sessions on organiser endpoints — `/api/organiser/*` accepts only OSN access JWTs (`osnAuth()` + ownership gates); the guest cookie is never consulted there
- [x] Organiser dashboard (`cire/organiser`) — tabbed Guests / Events view + inline import panel (2 file inputs → preview diff → apply; authenticated via OSN sign-in since the merge). History/revert UI deferred.
- [x] **CSV format explainer redesign** (`ImportPanel.tsx` `CsvFormatHelp`) — replaced the dense prose disclosure with an approachable 3-step visual guide, `open` by default, a required/optional chip legend, and a `MiniMatrix` illustrating the one-`yes`-column-per-event convention. Still a native `<details>`/`<summary>` (keyboard + SR accessible, no JS); header constants come from `lib/import-templates`.
- [x] **Explainer overhaul + step reorder** (`feat/cire-csv-explainer`) — the steps now follow the natural flow a non-technical couple takes: **① New here? → download the template** (the download prompt moved up from step 3, per the product owner: "'New here?' is strange for step 3, should be step 1"), **② Fill in your details** (Events + Guests guidance), **③ Upload & preview**. Each sheet's guidance gains a clearly-styled **"Good to know!"** aside: a labelled **Key** (gold chip = mandatory, muted chip = optional), the Events `YYYY-MM-DDTHH:MM:+GMT` timestamp format, an **IANA** timezone (hyperlinked to the tz-database list, new tab + `rel="noreferrer"`), full http(s) Pinterest/Maps URLs, the `DisplayName:#RGB` dress-code palette (`|`-separated), and the Guests rules (one row per guest, group a household by repeating the same Family Name, mark attendance with `yes`/`true`/`1`/`x`). The key + every rule mirror the `cire/api` parser (`REQUIRED_EVENT_COLUMNS` / `REQUIRED_GUEST_COLUMNS`, truthy-cell set, `|`-delimited palette). Tests assert the reorder (step 1 = download), the key, and the IANA link. Visual layout still wants a browser eyeball.
- [x] **Step-2 progressive disclosure** (`feat/cire-csv-explainer-refactor`) — the product owner flagged step 2 ("Fill in your details") as "far too long": it stacked **both** the Events and the Guests guidance fully expanded, each with its own "Good to know!" panel **and** its own mandatory/optional key — a wall of text. Refactored to progressive disclosure without losing any guidance: (1) the mandatory/optional **Key now renders once** (shared, above the toggle) instead of per sheet; (2) an accessible **Events / Guests tab toggle** (`SheetTabs` — ARIA `tablist`/`tab`/`tabpanel`, ←/→/Home/End keyboard nav, `aria-selected`, `focus-visible` ring, gold underline) shows **one sheet at a time** (Events first); (3) the deep per-field rules moved from the always-open "Good to know!" into a collapsible **"Formatting tips"** `<details>` aside (`FormattingTips`), so the default sheet view is just the column chips + a one-liner and the nitty-gritty is one click away. Substance preserved verbatim — timestamp format + `2026-11-14T15:00:+11:00` example, the **IANA** tz-database hyperlink, full-URL note, `DisplayName:#RGB` palette (Events); one-row-per-guest, repeat-Family-Name grouping, `yes`/`true`/`1`/`x` attendance tokens (Guests). The 3-step spine + download-template buttons are unchanged. Tests: switching to Guests swaps the visible guidance (one at a time), the key renders exactly once and survives a sheet switch, the IANA link + timestamp/palette examples still resolve. **Visual layout (toggle + disclosure interaction) still wants a browser eyeball.**
- [x] `GET /api/organiser/events` — full event details (used by EventTable + GuestTable for human-readable event tags)
- [x] Multi-origin CORS allowlist on the API so the organiser portal (`:4322`) can call the API alongside the guest web app (`:4321`)
- [ ] Extend `OrganiserView` to display family-grouped guests with shareable publicId + password (show password only at family creation, hash thereafter — surface a "regenerate password" action)
- [ ] Organiser portal: history / revert UI (deferred from initial cut)

## Cloudflare wiring

- [ ] Replace `bun:sqlite` runtime in `cire/api/src/index.ts` with `drizzle(env.DB)` on D1
- [ ] `bunx wrangler d1 migrations apply cire-db --local` in dev script
- [ ] `bunx wrangler types` after binding changes
- [ ] **Provision R2 bucket `cire-sheets` (and `cire-sheets-preview`) before first deploy** — `bunx wrangler r2 bucket create cire-sheets`. Binding `SHEETS` is already declared in `cire/api/wrangler.toml` as of PR-A.
- [ ] Batch import respects 50ms CPU / 30s wall-time Worker limits — chunk inserts to ~100 rows; consider Durable Objects or Queues for guest lists ≥ ~500 families
