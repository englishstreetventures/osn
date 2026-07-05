---
title: "Cire TODO — security backlog"
tags: [todo, security]
related:
  - "[[index]]"
  - "[[overview]]"
  - "[[review-findings]]"
last-reviewed: 2026-07-05
---

# Security Backlog

See [[overview]] for observability rules that apply to all security-sensitive code paths. See [[review-findings]] for severity prefix conventions.

Completed findings are archived in `[[changelog/security-fixes]]` (Migrated from security.md, 2026-06-21) — including the host-preview-code branch findings, the Critical/High/Medium tiers, the image-crop + per-event-image validation surfaces, and the invite-builder / account-linking / observability review findings. Only OPEN findings live below.

## High

- [ ] Revisit `overrides.vite` in root `package.json` when Astro publishes Vite 8 support — current `^7.3.2` pin would force-downgrade an Astro-with-Vite-8 install (see PR #25 perf review). **Still blocked (re-verified 2026-06-20):** `bun.lock` resolves **`vite@7.3.2`** and Astro is still on the Vite 7 line, so the override remains load-bearing — leave it. Separately, the **vite `GHSA-fx2h-pf6j-xcff`** advisory (`server.fs.deny` bypass on Windows alternate paths, **high**) DOES still fire at `--audit-level=high` against `vite@7.3.2` (the override pins below the patched `vite ≥7.3.5`), so its `--ignore=GHSA-fx2h-pf6j-xcff` in `lefthook.yml` stays in place (dev-server/Windows-only, no production path). Both self-resolve once Astro ships Vite 8 support and the override can be lifted to a patched line.

## Low

- [ ] **CSV-S-L1** — the organiser CSV export routes (`rsvps.csv`, `guests.csv`, `events.csv`) have no rate limit, unlike the mutation groups in the same route file. An authenticated organiser (or a compromised organiser token) can loop them and burn D1 read quota / Worker CPU on the Free tier. Add a modest per-user limiter (~10 exports/min, existing Upstash per-user backend) to the export routes or the dashboard-read group. Low because the caller must already hold a valid OSN access token AND pass `weddingMember()`. See [[cire-auth]] + root `[[wiki/runbooks/free-tier-limits]]`. (guests/events CSV export branch review)
- [x] **CSV-S-L2** (fixed in the same PR) — the CSV export handlers' `catchAllDefect` recovery returned 500 silently, violating the "every catch emits a log line" rule. Fixed: shared `exportDefect` recovery logs `csv export failed` with the export name + `weddingId` only (no guest data) before answering the generic 500 — applied to all three export routes incl. the pre-existing `rsvps.csv`.
- [x] **CSV-C-L1** (fixed in the same PR, documentation-only) — `guests.csv` surfaces the `families` invite-tracking timestamps (`code_shared_at`, `first_opened_at`, `deactivated_at`) which had no data-map row. Added the Art. 30 row to root `[[wiki/compliance/data-map]]` (purpose: organiser invite-delivery tracking; basis Art. 6(1)(f); retention: 1-year families sweep; recipients: organiser/co-hosts incl. CSV export).
- [ ] **CROP-S-L1** — the invite/event image serve routes (`imageResponseHeaders` in `cire/api/src/routes/invite.ts`) send `Cache-Control: public, max-age=31536000, immutable` with `Vary: Accept` only, while the app-level CORS plugin echoes a per-request ACAO. Any **future CORS-mode consumer** of these URLs (a reintroduced `crossOrigin` attribute, a `fetch()` of image bytes, the anticipated `$toCanvas` export) re-triggers the browser cache-entry mode-mixing that broke the crop editor: a cached no-cors response replayed to a cors-mode request fails the CORS check without touching the network. Prerequisite before shipping any such consumer: add `Vary: Origin` (ideally an unconditional ACAO for allowlisted origins — the endpoint is public). Low: today no CORS-mode consumer exists, content never varies on credentials, and the constraint is documented in `[[invite-builder]]`. (crop-editor CORS-cache fix branch review)
- [ ] Verify `ORGANISER_TOKEN` is not set as a CF secret on the deployed cire-api worker — the `X-Organiser-Token` code path is deleted, but a secret set during the interim would linger as stale config. If present: `wrangler secret delete ORGANISER_TOKEN` (manual, from `cire/api`).
      </content>
