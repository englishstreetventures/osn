---
title: "Cire TODO — security backlog"
tags: [todo, security]
related:
  - "[[index]]"
  - "[[overview]]"
  - "[[review-findings]]"
last-reviewed: 2026-06-21
---

# Security Backlog

See [[overview]] for observability rules that apply to all security-sensitive code paths. See [[review-findings]] for severity prefix conventions.

Completed findings are archived in `[[changelog/security-fixes]]` (Migrated from security.md, 2026-06-21) — including the host-preview-code branch findings, the Critical/High/Medium tiers, the image-crop + per-event-image validation surfaces, and the invite-builder / account-linking / observability review findings. Only OPEN findings live below.

## High

- [ ] Revisit `overrides.vite` in root `package.json` when Astro publishes Vite 8 support — current `^7.3.2` pin would force-downgrade an Astro-with-Vite-8 install (see PR #25 perf review). **Still blocked (re-verified 2026-06-20):** `bun.lock` resolves **`vite@7.3.2`** and Astro is still on the Vite 7 line, so the override remains load-bearing — leave it. Separately, the **vite `GHSA-fx2h-pf6j-xcff`** advisory (`server.fs.deny` bypass on Windows alternate paths, **high**) DOES still fire at `--audit-level=high` against `vite@7.3.2` (the override pins below the patched `vite ≥7.3.5`), so its `--ignore=GHSA-fx2h-pf6j-xcff` in `lefthook.yml` stays in place (dev-server/Windows-only, no production path). Both self-resolve once Astro ships Vite 8 support and the override can be lifted to a patched line.

## Low

- [ ] Verify `ORGANISER_TOKEN` is not set as a CF secret on the deployed cire-api worker — the `X-Organiser-Token` code path is deleted, but a secret set during the interim would linger as stale config. If present: `wrangler secret delete ORGANISER_TOKEN` (manual, from `cire/api`).
</content>
