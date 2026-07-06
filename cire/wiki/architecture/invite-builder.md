---
title: "Invite Builder"
tags: [architecture, api, web, db]
related:
  - "[[index]]"
  - "[[monorepo-structure]]"
last-reviewed: 2026-07-05
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
`null`) means **use the built-in default** — so a partially-filled section still
renders the original hard-coded copy for the fields the organiser left blank.

## Conditional segments (empty ⇒ hidden)

A section that has **no content at all** is not shown on the guest invite — we
never paint an empty full-screen hero or an empty "Our Story" surface. "Absent"
means null, empty-string, **or whitespace-only** (typing only spaces does not
fill a field). The single source of truth for these predicates is
`cire/web/src/components/invite-emptiness.ts` (`hasText`, `isHeroEmpty`,
`isStoryEmpty`, `hasPinterest`, `hasDressCode`).

| Segment                       | Rendered when…                                            | Where                                   |
| ----------------------------- | --------------------------------------------------------- | --------------------------------------- |
| **Hero** (full-screen)        | it has an image **OR** a title **OR** a subtitle          | `InviteHeader.tsx` (`showHero`)         |
| **Our Story**                 | it has a heading **OR** a body **OR** a story image        | `InviteHeader.tsx` (`showStory`)        |
| **Event → Inspiration**       | the event has a `pinterestUrl`                             | `DetailsModal.tsx` (`hasPinterest`)     |
| **Event → Dress Code**        | the event has a dress-code description **OR** a palette swatch | `DetailsModal.tsx` (`hasDressCode`) |

Image-only or title-only heroes are valid (the empty default "V & R" only renders
as a fallback **inside** an otherwise-shown hero). The Our-Story eyebrow is a
label, not content — it does not keep the section alive on its own.

**Builder reflection (no surprises):** `InviteBuilder.tsx` shows a per-section
badge — **"Shown"** vs **"Hidden — empty"** — on the Hero and Our Story fieldsets,
driven by the **same** emptiness logic (mirrored in
`cire/organiser/src/lib/invite-emptiness.ts`, since the two packages share no
code). The badge updates **live** as the organiser types, so they know exactly
what a guest will see before saving. Keep the two predicate files in lockstep.

## Required event fields (Location + Start)

The event/guest source of truth is the CSV import, not the builder — but the
invite depends on every event having a **place** and a **start time**. The "Where"
section + the Open-in-Maps affordance both derive from the location, and the
"When" section + the calendar invite both derive from the start. So the spreadsheet
parser (`cire/api/src/services/spreadsheet.ts`, `parseEventsCsv`) treats **Event
Name, Start, End, Timezone, AND Location** as the required set
(`REQUIRED_EVENT_COLUMNS`):

- The **header row** must contain every required column ⇒ otherwise
  `MissingRequiredColumn` (the import preview surfaces e.g. _"Location is
  missing"_).
- Each **data row** must have a non-empty (non-whitespace) value for Name, Start,
  End, Timezone, and Location ⇒ otherwise `MalformedSpreadsheet` with a specific
  reason + 1-indexed row/column (e.g. _"Location is required"_, _"Start is
  required"_), shown in `ImportPanel.tsx` rather than a generic failure.

The organiser-facing template mirror (`cire/organiser/src/lib/import-templates.ts`,
`EVENT_REQUIRED_HEADERS`) lists Location under the **required** chips, kept in
lockstep with the parser by `import-templates.test.ts`.

## Theme (per-section fonts + colours)

A second bounded surface on the same row: two global fonts (`headingFont`,
`bodyFont`) plus an accent + surface colour for each of four named sections.
Single source of truth: `cire/api/src/schemas/invite.ts` (`THEME_SECTIONS`,
`FONT_CHOICES`, `InviteThemeBody`).

| Section              | Theme key | Accent colour         | Surface colour          |
| -------------------- | --------- | --------------------- | ----------------------- |
| Hero                 | `hero`    | `heroAccentColor`     | `heroSurfaceColor`      |
| Our Story            | `story`   | `storyAccentColor`    | `storySurfaceColor`     |
| Event Details        | `details` | `detailsAccentColor`  | `detailsSurfaceColor`   |
| Code Entry & Welcome | `welcome` | `welcomeAccentColor`  | `welcomeSurfaceColor`   |

The `welcome` section (migration `0027_welcome_theme.sql`) covers the guest
site's **invite-code entry form and the post-claim welcome banner**
(`LoginSection.tsx`), which were previously pinned to the built-in green/gold
tokens with no organiser control.

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
`0009_invite_customisations.sql` + `0014_invite_theme.sql` +
`0017_hero_display_options.sql`) — one row per wedding (`wedding_id` PK + cascade
FK ⇒ 1:1). Nullable text columns + nullable `hero_image_key` / `story_image_key` +
nullable theme columns (`theme_heading_font`, `theme_body_font`, and
`{hero,story,details,welcome}_{accent,surface}_color` — the `welcome` pair
landed in `0027_welcome_theme.sql`) + the two **hero display** columns
`hero_image_style` (`blurred | regular`, **NOT NULL DEFAULT `blurred`**) and
`hero_title_backdrop` (`none | solid`, **NOT NULL DEFAULT `none`**). The two
hero-display columns are NOT NULL with defaults that reproduce today's look, so a
forward-only `ADD COLUMN` needs no backfill and an un-customised wedding renders
unchanged. Image columns store **R2 object keys**, not URLs (mirrors how `imports`
stores its CSV keys). The theme + hero-display ride the **same row + same read
query** — no extra table, no extra round-trip. LOCKSTEP DDL mirror lives in
`cire/api/src/db/setup.ts` (kept in sync with the migration + schema).

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
  - `GET /invite` → current customisation (text + image URLs + theme +
    `heroDisplay`).
  - `PUT /invite/text` → upsert the five text fields (empty ⇒ default).
  - `PUT /invite/theme` → upsert the theme (fonts + per-section colours) **plus the
    two hero display options** (`heroImageStyle ∈ {blurred,regular}`,
    `heroTitleBackdrop ∈ {none,solid}` — both required, total body). A bad colour,
    unknown font, or unknown hero-display literal ⇒ 400 (whole body rejected,
    nothing persisted).
  - `POST /invite/image/:slot` → upload an image.
  - `DELETE /invite/image/:slot` → reset slot to default.
  - Ownership mismatch returns **403, never 401** (a 401 makes `@osn/client`
    `authFetch` discard a valid session). See `[[wiki/systems/cire-auth]]`.

Image URL paths are returned relative to the API origin (`/api/invite/<slug>/
image/<slot>?v=…`); clients (guest island + organiser preview) prepend their API
base.

### Responsive image variants + the blurred hero backdrop

`GET /api/invite/:slug/image/:slot` optionally transforms the R2 original through
the Cloudflare Workers **Images** binding (`env.IMAGES`) into a bounded,
allowlisted **variant** — `cire/api/src/services/invite-image-transform.ts`
(`IMAGE_VARIANTS`, the single source of truth):

| Variant   | Width  | Blur            | Used for                                   |
| --------- | ------ | --------------- | ------------------------------------------ |
| `thumb`   | 320px  | —               | small in-page thumbnails / `srcset`        |
| `card`    | 800px  | — (the default) | common in-page size (story photo, cards)   |
| `hero`    | 1600px | —               | a crisp full-res hero, where wanted        |
| `hero-bg` | 1600px | **server-side** | the **blurred** full-bleed hero backdrop   |

Named variants (not an arbitrary `?w=` / `?blur=`) are deliberate: cardinality is
exactly four per slot, which keeps the edge cache hot and denies an attacker the
ability to mint unbounded distinct transform URLs (a cache-poisoning / cost
amplifier — the Images binding bills per call). An unknown/absent `?variant=`
collapses to `card`, never a 400.

**Blur is a server constant, never client input.** `VARIANT_BLUR` maps a variant
to a fixed Gaussian blur radius (`hero-bg` → ~28 in Cloudflare-Images terms; tune
that one constant for a softer/sharper backdrop). `blurForVariant()` returns it;
`transformAsset` threads it into `.transform({ width, blur })`. Only `hero-bg` is
blurred — the sharp `hero`/`card`/`thumb` variants are unaffected, so the blur is
scoped to the backdrop and can never be swept across values by a malicious client.
The binding input is always the organiser's own uploaded R2 object.

When the Images binding is absent (local/dev/tests, or no Images product) or a
transform fails, the route falls back to the raw R2 original — it never 500s on a
transform miss. Edge-cached via the Worker Cache API, keyed on
`slug+slot+variant+format(+server version)`.

### Upload validation

`POST /invite/image/:slot` reads the raw body. Defences: a Content-Length
pre-check + a post-read byte cap (`MAX_IMAGE_BYTES` = 5 MB), and **magic-byte
sniffing** (`detectImageType`) — the stored content type comes from the bytes,
not the declared `Content-Type`, so a mislabelled / hostile payload (HTML, SVG)
is rejected (415). Allowlist: JPEG, PNG, WebP.

## Guest rendering (SSR, path-routed)

`cire/web` is an `output: "server"` Astro site (the `@astrojs/cloudflare`
adapter), deployed as a **Cloudflare Worker with Static Assets** — _not_ Pages.
**Which wedding renders is resolved FROM THE PATH per request**, so there is no
build-time `PUBLIC_WEDDING_SLUG` and any wedding renders from its own link:

- **`/<slug>`** (`cire/web/src/pages/[slug].astro`) — the per-wedding invite. The
  route reads `slug` from the path, fetches `GET ${PUBLIC_API_URL}/api/invite/<slug>`
  **server-side per request** (`cache: "no-store"`), and renders the existing
  hero/`InviteHeader`/`InvitePage` via the shared `InviteDocument.astro`. An
  unknown slug (API 404) returns a real **404** with a tasteful `NotFoundDocument`;
  a transient API error renders the invite shell with built-in defaults (no false
  404). The `?code=<host code>` auto-claim deep-link rides on `/<slug>?code=...`
  (LoginSection reads it client-side, unchanged).
- **`/`** (`cire/web/src/pages/index.astro`) — the bare domain. Resolves the
  deployment's primary wedding via `GET /api/primary-wedding` and **302-redirects
  to `/<slug>`** (carrying any `?code=`). No wedding configured (404) or a
  transient API error → a neutral "no invitation configured / unavailable" state,
  never a crash. The main link (`https://cireweddings.com/`) thus stays clean.
- **`/privacy`, `/terms`** — opt back into static prerendering
  (`export const prerender = true`); only the invite + bare-domain routes are
  per-request SSR.

`GET /api/primary-wedding` (public, `cire/api/src/routes/primary-wedding.ts`)
returns `{ slug }` for the sole wedding, or the **most-recently-created** when
several exist (documented limitation — the bare domain can only point at one;
the rest are reachable at their own `/<slug>`), and **404** when none exist.

The server fetch still paints the hero with the real image/copy in the SSR'd
HTML (fast LCP, no-JS fallback). Both guest islands then **revalidate at runtime**
and let the fresh `/api/invite/:slug` response override the per-request snapshot:

- `cire/web/src/components/InviteHeader.tsx` (`client:load`) — the hero + "Our
  Story" sections. Fetches on mount via a SolidJS `createResource` seeded with
  the build-time `initial` prop, and drives the hero **image**, copy, story, and
  the hero/story **theme** from the live response.
  - **Hero backdrop image (blurred vs regular — organiser choice)**: the uploaded
    hero image renders as a full-bleed **backdrop behind the title**. The
    `heroDisplay.imageStyle` field (a closed `blurred | regular` union, default
    `blurred`) picks the requested variant via `heroVariant()`:
    - `blurred` (default — today's look) ⇒ the server-blurred `hero-bg` variant —
      a soft backdrop; the blur radius is a server constant, never sent from the
      client.
    - `regular` ⇒ the sharp full-bleed `hero` variant (no blur).

    Either way one 1600px width is enough (a fixed-purpose `src`, not a responsive
    `srcset`). The title (in front) stays readable via the radial-gradient scrim.
  - **Hero title backdrop (legibility panel — organiser choice)**: the
    `heroDisplay.titleBackdrop` field (`none | solid`, default `none`) controls a
    panel behind the title block. `none` keeps just the radial scrim (the original
    look); `solid` wraps the title + monogram + subtitle in a translucent rounded
    panel whose background is the theme **surface** colour (`--invite-surface`)
    when set, else a dark `oklch(0% 0 0 / 0.45)` scrim panel — so the title reads
    over any busy/sharp photo. (Future: auto contrast-check the title colour vs the
    image and auto-enable the panel — see `[[todo/future]]`.)
  - **Visible-or-gone load lifecycle (the "invisible hero" SSR fix)**: the backdrop
    fades in on `load`; on a failed load (`onError` — e.g. a 404'd image) it
    **unmounts** so the base gradient shows through (replacing an `onLoad`-only gate
    that had no failure path). Two SSR-specific traps are handled so a served hero
    is reliably visible:
    1. **Missed `load` on hydration.** On an SSR page the browser starts loading
       the server-rendered `<img>` during HTML parse, and its `load` event commonly
       fires **before** the Solid island hydrates and attaches `onLoad` — so
       `onLoad` would never run and the image stayed pinned at opacity 0. The island
       holds a `ref` and, in `onMount`, checks `img.complete && img.naturalWidth > 0`
       → marks it `loaded` immediately. `onLoad`/`onError` still cover the
       not-yet-loaded path.
    2. **Re-arm only on a real URL change.** The re-arm effect now resets to
       `pending` (opacity 0) **only when the resolved backdrop `src` actually
       changes** (a re-upload, or a `blurred`↔`regular` variant flip). The on-mount
       no-store revalidation returns the **same** url; the old effect reset to
       `pending` on every `data()` change, but the unchanged `<img src>` never
       re-fired `load`, leaving a shown image stuck invisible. On a genuine change a
       `queueMicrotask` re-runs the ref check to also catch an already-cached new
       src.
- `cire/web/src/components/InvitePage.tsx` (`client:visible`) — the
  "details"/events section. Also revalidates on mount (`createResource` seeded
  with the per-request `theme` prop, keyed on the `slug` prop threaded from
  `InviteDocument.astro`) so the events-section theme reflects the latest saved
  value. A non-OK / failed revalidation keeps the already-painted snapshot theme;
  with no `slug` (e.g. unit tests) the prop is used as-is.

Net effect: **invite customisation (hero image + theme) is reflected per request +
revalidated on mount — no site rebuild needed, and no baked-in wedding slug.** The
per-request SSR snapshot is the fast-first-paint / no-JS placeholder; the on-mount
fetch is the source of truth. The `/api/claim` event/guest flow (`InvitePage`'s
claim/RSVP logic) and its animations are untouched.

### Organiser links (path-routed)

Both organiser-side links that point at the guest site now carry the wedding slug
in the **path** (so they open the correct wedding, not whatever the bare domain
resolves to):

- **Preview invite** (`cire/organiser/.../PreviewInviteButton.tsx`): opens
  `${CIRE_WEB_URL}/<slug>?code=<host preview code>`. The slug comes back from the
  `POST /api/organiser/weddings/:weddingId/preview-code` response, which now
  returns `{ publicId, slug }`.
- **Copy invite message** (`cire/organiser/.../invite-message.ts`, used by
  `GuestTable`): links to `${CIRE_WEB_URL}/<slug>`. The slug is threaded
  `OrganiserApp → DashboardTabs → GuestTable → buildInviteMessage`.

**Cache discipline (why edits surface):** `GET /api/invite/:slug` is sent
`Cache-Control: no-store`, and both islands fetch it with `{ cache: "no-store" }`.
The JSON hands out the version-busted hero/story image URLs, so if it were itself
cached (heuristically by the browser, or at an edge) the on-mount revalidation
would read a stale body and the new hero/theme would never appear — the exact
"saved in settings but not on the invite" symptom. The image **bytes** at
`/api/invite/:slug/image/:slot` stay `immutable, max-age=1y`; that's safe because
their URL carries `?v=<updatedAt>` and every upload bumps `updatedAt` + writes a
fresh R2 key.

The **theme** drives CSS custom properties (`--invite-accent`, `--invite-surface`,
`--invite-heading`, `--invite-body`) set on each section wrapper's inline `style`,
consumed by the section's elements via `var(--invite-*, <built-in-token>)`
fallbacks — so an unset (or validation-rejected) field resolves to the original
gold / surface / display token. `cire/web/src/components/invite-theme.ts`
(`sectionThemeVars`, `fontStack`) builds the validated variable map (re-checking
colours + resolving the font key). The hero + story sections read the live theme
from `InviteHeader`'s resource; the "details"/events **and** "welcome" (code
entry + welcome banner) sections read the live theme from `InvitePage`'s own
resource (both override the build-time snapshot above).

> **Welcome section token bridge.** `LoginSection`'s states (input focus border,
> submit-button hover fill) live in Tailwind pseudo-class utilities that inline
> styles can't reach, so instead of per-element `var(--invite-accent, …)`
> styles the section wrapper **re-points the scoped Tailwind tokens** at the
> validated variables: `--color-gold: var(--invite-accent, <gold literal>)`,
> `--font-display`/`--font-body` likewise, and `background-color:
> var(--invite-surface, transparent)`. Every gold/font utility inside the
> section — including hover/focus — then follows the organiser's pick, and an
> unset variable falls through to the literal built-in token (a var()
> self-reference would be a cycle, hence the literals).

> **Render-boundary resilience.** `sectionThemeVars` reads the section sub-object
> defensively (`theme[section]?` → fall back to the built-in tokens) and never
> throws on a truthy-but-partial theme. This matters because the "details" map
> styles the **events** section wrapper, so a throw here would crash the
> `InvitePage` island and make the whole events list vanish. A malformed/partial
> payload now degrades to the default section colours rather than taking events
> down — mirroring the organiser preview helper's `?? default` behaviour.

`PUBLIC_WEDDING_SLUG` (env) selects which wedding's customisation the guest site
renders (default `cire-wedding`, the bootstrap wedding slug).

## Organiser UI

`cire/organiser/src/components/InviteBuilder.tsx`, mounted as a new **"Invite"**
tab in `DashboardTabs.tsx`. Text inputs + per-slot image pickers (with preview +
remove) drive the organiser endpoints via `useAuth().authFetch`; `solid-toast`
for feedback, `isAuthExpired` / `redirectToLogin` for 401 handling — same
patterns as `ImportPanel`. A **Theme** fieldset adds two font `<select>`s (closed
`FONT_OPTIONS` mirror of the server enum) and, per section, two popover
accent/surface pickers (`ColorPicker.tsx`, Kobalte ColorArea + hue slider +
labelled hex field) each with a "Use default" clear (null ⇒ built-in token).
The picker only emits a full `#rrggbb` (never partial input, and never
mid-typing: the hex field commits only on a complete 6-digit value — 3/4-digit
shorthand would otherwise parse and hijack the colour after three keystrokes —
while shorthand still commits on blur via Kobalte's normalisation), so the UI
can never submit a colour the server allow-list would reject. The **Hero** fieldset
also carries two segmented toggles (`ToggleField`, a small `radiogroup`) — **Hero
image** (Blurred / Regular) and **Title backdrop** (None / Solid). All of these —
fonts, colours, **and the two hero display toggles** — are saved together via a
single `PUT /invite/theme` ("Save theme" button) independent of the copy save.

**Crop editor.** Per-slot "Crop" opens `ImageCropModal.tsx` (cropperjs **v2**
web components wrapped by the `Cropper` class). Two v1→v2 behaviour gaps are
compensated in the modal — v2's `initial-coverage` covers the **canvas**, not
the displayed image, and v2 dropped v1's built-in containment of the crop box
within the image. The modal therefore fits the opening selection to the
displayed image itself (`fitAspectBox` in `lib/image-crop.ts`, honouring the
active aspect preset), vetoes out-of-image drags/resizes through the
selection's cancellable `change` event, refits within the image on preset
switches, and re-seeds a saved crop to its exact stored rectangle (NaN
per-change ratio, so the preset lock never "cover"-adjusts it). Save converts
the selection-over-image bounding boxes into resolution-independent 0..1
source fractions plus the image's natural dimensions.

The modal's `<img>` **must not carry `crossOrigin`** (the root cause of the
editor opening dead in production long after the geometry fixes above). The
dashboard thumbnail loads the same cache-busted image URL as a plain no-cors
`<img>` first; the API serves it `Cache-Control: immutable` with `Vary: Accept`
only (no `Vary: Origin`), so the browser HTTP-caches the response **without**
CORS headers. A subsequent `crossOrigin="anonymous"` load of the identical URL
is answered from that cache entry, fails the CORS check without ever reaching
the network, and cropperjs's `$ready` rejects — the selection is never seeded
and the editor appears broken. The editor only reads element geometry and
`naturalWidth`/`naturalHeight`, never canvas pixels, so it has no need for a
CORS-mode image. If a future feature needs pixel access (e.g. client-side
export via `$toCanvas`), the image serve endpoint must first send
`Vary: Origin` (and ideally an unconditional ACAO for allowlisted origins) so
cors- and no-cors-mode responses never share a cache entry.

**Live theme preview.** A compact, representative mini-invite (one labelled card
per section: Hero / Our Story / Event Details) sits beside the colour controls and
updates **instantly** as the organiser changes a colour or font — driven by the
same picker signals, so they SEE the effect before saving (previously the change
only showed on the guest URL after a save). It is styled with the **same
`--invite-*` CSS variables** the guest invite consumes
(`--invite-accent/surface/heading/body`), via a small **local mirror** of the
guest mapping: `cire/organiser/src/lib/invite-theme-preview.ts`
(`previewSectionVars`, `previewFontStack`, `PREVIEW_DEFAULTS`). The mirror exists
because `cire/web`'s `invite-theme.ts` (and the `--font-display`/`--color-gold`
tokens) can't be imported across the package boundary cleanly, and the organiser
must never pull Effect / web internals — it's a plain Solid component with inline
`style`. Keep the var **names**, the font **keys**, the colour/font **defaults**,
and the "null ⇒ default token" precedence in lockstep with the guest file so the
preview stays faithful.

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
