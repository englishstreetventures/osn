---
title: "Invite Builder"
tags: [architecture, api, web, db]
related:
  - "[[index]]"
  - "[[monorepo-structure]]"
last-reviewed: 2026-06-18
---

# Invite Builder

Lets an organiser customise the **presentation** of the guest invite — swap a
couple of images, rewrite a few copy blocks, and apply a per-section **theme**
(fonts + colours) — on top of the existing animated invite. It is deliberately
additive: the event + guest **source of truth stays in the CSV import**
(`events` / `families` / `guests`), and this feature only layers per-wedding
image + text + theme overrides on top of the wedding root.

## Slots (closed set)

The customisable surface is a fixed, closed union — not a generic page builder.
Single source of truth: `cire/api/src/schemas/invite.ts`.

| Section   | Image slot | Text fields                                  |
| --------- | ---------- | -------------------------------------------- |
| Hero      | `hero`     | `heroTitle`, `heroSubtitle`                   |
| Our Story | `story`    | `storyEyebrow`, `storyHeading`, `storyBody`  |

Image slots: `INVITE_IMAGE_SLOTS = ["hero", "story"]`. The same union bounds the
`:slot` route param, the R2 key namespace, and the observability span/log
attributes (no free-form strings). Adding a slot is a conscious schema change.

A `null` text field (or an all-whitespace value, which the service normalises to
`null`) means **use the built-in default** — so an uncustomised wedding renders
exactly the original hard-coded copy.

## Theme (per-section fonts + colours)

A second bounded surface on the same row: two global fonts (`headingFont`,
`bodyFont`) plus an accent + surface colour for each of three named sections.
Single source of truth: `cire/api/src/schemas/invite.ts` (`THEME_SECTIONS`,
`FONT_CHOICES`, `InviteThemeBody`).

| Section       | Theme key | Accent colour         | Surface colour          |
| ------------- | --------- | --------------------- | ----------------------- |
| Hero          | `hero`    | `heroAccentColor`     | `heroSurfaceColor`      |
| Our Story     | `story`   | `storyAccentColor`    | `storySurfaceColor`     |
| Event Details | `details` | `detailsAccentColor`  | `detailsSurfaceColor`   |

Every field is nullable ⇒ "use the built-in token", so an un-themed (or
partially-themed) invite renders exactly as before.

- **Fonts** are a **closed enum** (`FONT_CHOICES`: `default`, `cormorant`,
  `lato`, `georgia`, `system-sans`, `system-mono`) — never a free-text font
  name / URL. The guest site owns the concrete `font-family` stack
  (`FONT_STACKS` in `cire/web/src/components/invite-theme.ts`); every key
  resolves to an **already-loaded** font (Cormorant Garamond / Lato) or a pure
  **system stack** — no new web-font / CDN dependency, no `@font-face`/SSRF
  surface, no render-block cost.
- **Colours** pass a strict server-side allow-list (`isThemeColor`) — only
  `#hex` / `rgb(a)` / `hsl(a)` / `oklch(...)` with a restricted inner-character
  class (no `url()`, `expression()`, `var()`, named colours, or attribute
  breakouts), length-capped at 64. This is the **CSS-injection gate**: a bad
  colour ⇒ 400, never persisted. The guest site **re-validates** the same
  allow-list (`isValidColor`) before emitting any CSS variable — defence in
  depth (the API allow-list and the guest allow-list are kept byte-identical).

## Storage

`wedding_invite_customisations` (`cire/db/src/schema.ts`, migrations
`0009_invite_customisations.sql` + `0014_invite_theme.sql`) — one row per wedding
(`wedding_id` PK + cascade FK ⇒ 1:1). Nullable text columns + nullable
`hero_image_key` / `story_image_key` + nullable theme columns
(`theme_heading_font`, `theme_body_font`, and `{hero,story,details}_{accent,
surface}_color`). Image columns store **R2 object keys**, not URLs (mirrors how
`imports` stores its CSV keys). The theme rides the **same row + same read
query** — no extra table, no extra round-trip. LOCKSTEP DDL mirror lives in
`cire/api/src/db/setup.ts`.

Images live in a dedicated **`cire-assets`** R2 bucket (binding `ASSETS`),
separate from the text-only CSV-import `SHEETS` bucket — different lifecycle
(binary, served publicly). Key namespace: `assets/<weddingId>/<slot>-<uuid>`.
The uuid suffix means a re-upload never collides and the superseded object is
deleted independently (best-effort; an orphan is recoverable, a failed upload is
not).

> The `cire-assets` (+ `cire-assets-preview`) buckets must be created before
> first deploy: `bunx wrangler r2 bucket create cire-assets`.

## API surface

Service: `cire/api/src/services/invite.ts` (`inviteService`, Effect). Binary R2
access: `cire/api/src/services/invite-assets.ts` (`AssetsR2Service` Tag — the
CSV-import `R2Bucket` is text-only and is **not** widened in place). Routes:
`cire/api/src/routes/invite.ts`, two sibling Elysia instances:

- **Public (no auth)** — under `/api/invite`:
  - `GET /api/invite/:slug` → text + image URL paths for the guest site.
  - `GET /api/invite/:slug/image/:slot` → image bytes from R2 (`Cache-Control:
    immutable`; the URL is cache-busted by `?v=<updatedAt>`).
  - Kept off the `osnAuth` gate (same sibling-instance split as `/api/rsvp`) so
    a guest with no OSN token can render the invite.
- **Organiser (authed)** — under `/api/organiser/weddings/:weddingId/invite`,
  behind `osnAuth()` + `weddingOwner()`:
  - `GET /invite` → current customisation (text + image URLs + theme).
  - `PUT /invite/text` → upsert the five text fields (empty ⇒ default).
  - `PUT /invite/theme` → upsert the theme (fonts + per-section colours); a bad
    colour or unknown font ⇒ 400 (whole body rejected, nothing persisted).
  - `POST /invite/image/:slot` → upload an image.
  - `DELETE /invite/image/:slot` → reset slot to default.
  - Ownership mismatch returns **403, never 401** (a 401 makes `@osn/client`
    `authFetch` discard a valid session). See `[[wiki/systems/cire-auth]]`.

Image URL paths are returned relative to the API origin (`/api/invite/<slug>/
image/<slot>?v=…`); clients (guest island + organiser preview) prepend their API
base.

### Upload validation

`POST /invite/image/:slot` reads the raw body. Defences: a Content-Length
pre-check + a post-read byte cap (`MAX_IMAGE_BYTES` = 5 MB), and **magic-byte
sniffing** (`detectImageType`) — the stored content type comes from the bytes,
not the declared `Content-Type`, so a mislabelled / hostile payload (HTML, SVG)
is rejected (415). Allowlist: JPEG, PNG, WebP.

## Guest rendering

`cire/web` is a `output: "static"` Astro site, so per-wedding values can't be
read at build time. The old static `Hero.astro` / `OurStory.astro` are replaced
by a client-hydrated SolidJS island `cire/web/src/components/InviteHeader.tsx`
(`client:load`) that fetches `GET /api/invite/:slug` on mount and applies
overrides, falling back to the original copy when a field is null. The island is
SSR'd with defaults at build time, so the first paint is the default copy and
customisations hydrate in (the hero background image fades in on load). The
`/api/claim` event/guest flow (`InvitePage`) and its animations are untouched.

The **theme** drives CSS custom properties (`--invite-accent`, `--invite-surface`,
`--invite-heading`, `--invite-body`) set on each section wrapper's inline `style`,
consumed by the section's elements via `var(--invite-*, <built-in-token>)`
fallbacks — so an unset (or validation-rejected) field resolves to the original
gold / surface / display token. `cire/web/src/components/invite-theme.ts`
(`sectionThemeVars`, `fontStack`) builds the validated variable map (re-checking
colours + resolving the font key). The hero + story sections read the theme from
the same `InviteHeader` data; the "details"/events section in `InvitePage` takes
the theme as a prop, resolved at build time in `index.astro` alongside the hero
(no client fetch waterfall).

`PUBLIC_WEDDING_SLUG` (env) selects which wedding's customisation the guest site
renders (default `cire-wedding`, the bootstrap wedding slug).

## Organiser UI

`cire/organiser/src/components/InviteBuilder.tsx`, mounted as a new **"Invite"**
tab in `DashboardTabs.tsx`. Text inputs + per-slot image pickers (with preview +
remove) drive the organiser endpoints via `useAuth().authFetch`; `solid-toast`
for feedback, `isAuthExpired` / `redirectToLogin` for 401 handling — same
patterns as `ImportPanel`. A **Theme** fieldset adds two font `<select>`s (closed
`FONT_OPTIONS` mirror of the server enum) and, per section, two native
`<input type="color">` accent/surface pickers each with a "Use default" clear
(null ⇒ built-in token). Native colour inputs only emit `#rrggbb`, so the UI can
never submit a colour the server allow-list would reject. Saved via a separate
`PUT /invite/theme` ("Save theme" button) independent of the copy save.

## Observability

cire/api now adopts `@shared/observability` (workerd-safe subpaths) — see
`[[overview]]`. The invite-builder surface is instrumented with spans, the
redacting logger, and metrics:

- **Spans**: `cire.invite.{getForWedding,getForWeddingId,getForSlug,
  imageKeyForSlug,upsertText,upsertTheme,setImage,removeImage}` +
  `cire.invite.{storeAsset,fetchAsset,deleteAsset}`.
- **Logs**: `Effect.logInfo` on save / upload / remove; `Effect.logWarning` on
  best-effort image cleanup failure; `Effect.logError` on every storage / DB
  defect path before returning the generic error body. All runs go through
  `runCire` so annotations are redaction-scrubbed. No `console.*`. No PII in
  logs (only `weddingId`).
- **Metrics**: `cire.invite.saved`, `cire.invite.asset.uploaded`, and the
  `cire.invite.asset.size` histogram (bytes), defined in
  `cire/api/src/metrics.ts`. No-op until a workerd exporter is wired (see
  `[[overview]]` → Deferred).

## Compliance

Uploaded images are personal data (wedding photos) and inherit the existing cire
retention gap. Tracked alongside the other cire entries — see
`wiki/todo/db.md` / `wiki/todo/api.md`.
