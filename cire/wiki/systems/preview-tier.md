---
title: "Preview Tier"
tags: [systems, deploy, api, web, organiser]
related:
  - "[[overview]]"
  - "[[invite-builder]]"
  - "[[contributing]]"
last-reviewed: 2026-07-22
---

# Preview Tier

A complete, disposable copy of cire for reviewing a feature branch on real
infrastructure. Deployed by `.github/workflows/deploy-cire-preview.yml`.

| Piece     | URL                                        | How                                       |
| --------- | ------------------------------------------ | ----------------------------------------- |
| API       | `https://api-preview.cireweddings.com`     | Worker, `wrangler deploy --env preview`   |
| Guest     | `https://invite-preview.cireweddings.com`  | Worker (Astro SSR), rewritten config      |
| Organiser | `https://cire-organiser-preview.pages.dev` | Pages project `cire-organiser-preview`    |

## Why a whole tier, not just a preview frontend

Because a **schema change cannot be reviewed until the schema has changed**, and
doing that to production before merge is not an option. Pointing a preview guest
site at the prod API would show the old shape — for a change like the invite
colour scheme (migration `0044`, which DROPS columns) the preview would render
the fallback look and prove nothing.

So the preview API is bound to its own D1, `cire-db-preview`
(`28d615d2-1e15-4592-9e44-cbf9c5af953a`, created 2026-07-22, OC/Sydney like the
rest of the infra), and the `-preview` R2 buckets. A branch's migrations run
there. **Preview data is disposable** — the workflow re-seeds on every push and
nothing should be expected to survive.

## What is shared with production, and what is not

**Shared:** the OSN identity issuer (`id.cireweddings.com`). A reviewer signs in
with their real passkey, which is what makes the organiser portal reviewable at
all — no separate identity tier to provision. Weddings they create land in the
preview database.

**Not shared:** the database, both R2 buckets, the Worker names, the routes, and
the rate-limiter namespace (`1002`, so preview traffic cannot eat production's
claim-attempt budget).

**Deliberately broken:** `ZAP_API_URL` is unset on `[env.preview]`. Named
environments do not inherit top-level `[vars]`, so the code default (localhost)
applies and vendor-enquiry delivery fails closed. A preview must never send a
real email to a real vendor; the rest of the enquiry flow still works.

## Gotchas worth keeping

- **The guest site's generated config must be rewritten, not reused.**
  `@astrojs/cloudflare` writes `dist/server/wrangler.json` by EXTENDING
  `cire/web/wrangler.jsonc`, which carries the production worker name and the
  `invite.cireweddings.com` custom domain. Deploying that from a branch would
  overwrite the live guest site. The workflow rewrites `name` and `routes` (and
  strips `legacy_env`, as the production deploy does).
- **The organiser preview deploys to its Pages project's production branch**, so
  it serves at the stable `cire-organiser-preview.pages.dev`. A per-commit Pages
  preview URL is a different origin every push, and every API call would fail
  the CORS origin guard.
- **`events.slug` is UNIQUE across ALL weddings**, not per wedding. The preview
  seed's three sample ceremonies therefore need distinct slugs
  (`evergreen-ceremony`, `chapel-ceremony`, …) or two of the three rows are
  silently dropped by `INSERT OR IGNORE` and their `guest_events` fail the FK.

## Seed

`cire/db/seed/preview-seed.sql` — three sample weddings identical in content and
differing only in colour scheme (built-in / `chapel` / `jewel`), so schemes can
be compared side by side. Idempotent: content rows are `INSERT OR IGNORE`, the
customisation rows are `INSERT OR REPLACE` so an edited scheme actually lands on
the next push.

Sample family codes (they guard nothing but sample data on a disposable
database): `PREVIEW-EVERGREEN-0001`, `PREVIEW-CHAPEL-0002`, `PREVIEW-JEWEL-0003`.

## Previewing a different branch

Add it to the workflow's `branches:` list, or run the workflow from the Actions
tab against any branch. One preview exists at a time — the concurrency group
serialises deploys and the URLs are fixed.
