---
title: "Invite Builder"
tags: [architecture, api, web, db]
related:
  - "[[index]]"
  - "[[monorepo-structure]]"
  - "[[invite-templates]]"
last-reviewed: 2026-08-01
---

# Invite Builder

Lets an organiser customise the **presentation** of the guest invite — swap a
couple of images, rewrite a few copy blocks, and apply a per-section **theme**
(fonts + a five-colour scheme) — on top of the existing animated invite. It is deliberately
additive: the event + guest **source of truth stays in the CSV import**
(`events` / `families` / `guests`), and this feature only layers per-wedding
image + text + theme overrides on top of the wedding root.

## Slots (closed set)

The customisable surface is a fixed, closed union — not a generic page builder.
Single source of truth: `cire/api/src/schemas/invite.ts`.

| Section              | Image slot | Text fields                                  |
| -------------------- | ---------- | -------------------------------------------- |
| Hero                 | `hero`     | `heroTitle`, `heroSubtitle`                   |
| Our Story            | `story`    | `storyEyebrow`, `storyHeading`, `storyBody`  |
| Code Entry & Welcome | —          | `welcomeMessage` (post-claim greeting line)   |
| Events ("details")   | —          | `detailsEyebrow`, `detailsHeading`            |
| Closing (`footer`)   | `footer`   | `footerMessage` (closing note, **no default**) |
|   ↳ post-claim only, and reuses the welcome tone | | |

The `details`/`welcome` copy fields landed in migration
`0028_details_welcome_copy.sql` — they closed the last hardcoded guest-facing
copy (the "Celebrate With Us" / "Your Events" events header and the
"We are delighted to invite you…" greeting).

### The closing section

The invite's last section — the couple's own sign-off — built over three
migrations: `0049_invite_footer_message.sql` (the note),
`0050_invite_footer_image.sql` (`footer_image_key` + `footer_image_crop`, the
image above it). Note and image are INDEPENDENT: either alone renders.

**The image is a closing hero — full-bleed, edge to edge** (2026-07-31). It
shipped as a small centred square sized for a monogram or signature; couples
reach for a photograph here, and at 200px the sign-off read like a stray avatar
rather than the invite's closing image. It now spans the viewport:

| | Before | Now |
|---|---|---|
| Box | `w-[min(200px,45vw)]`, centred, rounded | `w-full`, viewport edge to edge, square corners |
| Height | the crop's pixel aspect, **square** fallback | the crop's pixel aspect (**16∶9** fallback), or the source's natural ratio when uncropped; bounded at `85dvh` |
| Crop | exact region (`cropBackgroundStyle`) | unchanged — still the exact region |
| Variants | `thumb` 320w / `card` 800w, `sizes="200px"` | `card` 800w / `hero` 1600w, `sizes="100vw"` |

**The crop decides the shape, and that is the point.** The band takes the crop's
own aspect, so a 3∶1 panorama publishes as a 3∶1 panorama and a 4∶3 scene as a
4∶3 scene — the organiser frames what guests get. This is deliberately NOT the
hero backdrop's treatment, which pins a viewport-shaped box and demotes the crop
to a focal point (`heroCropBackgroundStyle`): the hero's box is dictated by the
screen it fills, while this band has no shape of its own to defend. A fixed band
height was tried first and rejected for exactly that reason — it silently
overrode the framing an organiser had just chosen. With no crop saved the image
keeps its natural aspect (nothing chosen ⇒ nothing cut).

The one bound is `85dvh` — a 4∶5 portrait at 1440px wide would otherwise want
1800px of band and bury the note under several screens of image — and on the
cropped path it is applied to the box's **width** (`width: 100%` plus
`max-width: 85dvh × aspect`, i.e. `min(100%, cap × aspect)`, centred), never as
a `max-height` clip. Measured in Chromium: a `max-height`-clipped band shows a
top-anchored crop's TOP STRIP ONLY, because the background layer sits at the
crop's own offset and has no idea the box got shorter — silently cutting the
framing this whole path exists to honour. Bounding the width instead means an
extreme portrait crop stops being edge-to-edge (it becomes a centred column at
the widest size that fits a screen) but is still shown WHOLE and exact. A wide
crop is unaffected: a 2∶1 band still measures 1440×720 on a laptop, 390×195 on
a phone. The uncropped `<img>` keeps `max-h` + `object-cover`, which genuinely
does crop centred, and applies only to an image nobody framed.

Two properties exist purely to keep the band from moving the page under the
guest, both of which the 200px square didn't need. The `<img>` carries
`aspect-ratio: auto 16/9` — the *fallback* form, so a box is reserved before a
lazy, `content-visibility`-deferred image decodes, and the source's own ratio
still wins afterwards; without it the note and the site footer jumped down by up
to a screen height on decode. And `contain-intrinsic-size` is computed
(`auto calc(100vw / aspect + 24rem)`) rather than a flat guess, because the band
is exactly `100vw` wide at a known aspect — a placeholder 2–3× short of the
rendered height moves the scrollbar at the moment the guest scrolls in.

That contract is only honest if the builder shows it, so `SectionSample` — the
markup behind BOTH the inline per-section preview and the composed `PreviewPane`
— renders the band edge-to-edge and **crop-aware**, using the same exact-region
technique at the same crop-driven aspect (`imageCrop` threaded through
`PreviewPaneProps["closing"]` and the builder's inline preview). `ImageField`'s
WYSIWYG thumbnail already showed the exact rectangle, so all three surfaces now
agree with the invite — including the width bound, which matters more in the
preview than on the guest page because that frame is short, so the cap fires far
more often. **The wiring is a silent-degradation seam:** `SectionSample` falls
through to the uncropped `<img>` when no crop reaches it and still renders
something plausible, so a dropped prop reinstates the old lie with a green
suite. It happened once during review — `SectionPreview` (the inline wrapper)
didn't forward `imageCrop`, so the inline preview showed the uncropped image
while the composed pane showed the crop. Both paths are now pinned by builder
tests that drive real draft state rather than passing the prop directly.

Two knock-ons: the section's horizontal padding moved off the `<section>` onto
the note's own block (the band has to reach past it), and `CROP_ASPECT.footer`
went 1∶1 → 16∶9 so the editor opens on the shape most couples want here — the
same value `LEGACY_CROP_ASPECT` falls back to in both packages when a saved crop
carries no captured source dims (three hand-kept copies; the two inside
`@cire/organiser` are pinned to each other by a drift guard, the cross-package
pair by convention). `cropAspectRatio` also gained a `[0.05, 20]` clamp in both
mirrors: `natW`/`natH` are validated only as positive and finite, and a ratio
that stringifies to exponential notation is a value CSS drops outright, which
would render the band as a zero-height box (`[[security]]` S-L1).

**It is behind the claim gate — enforced at the API, not in the render tree.**
The first cut gated it only with `<Show when={claimResult()}>`, which controls
rendering, not delivery: the note still shipped in the unauthenticated
`GET /api/invite/:slug` body and in the SSR'd island props, so it was one `curl`
away (S-H1). The gate is now real:

- `inviteService.getForSlug` **redacts** `footer` from the public payload. Every
  other field there (hero, story, events header, welcome greeting, theme) is
  public by design — it paints the shell anyone opening the link sees.
- `claimService.lookup` returns the closing content in the **claim response**,
  beside the events list, to a session that proved household membership.
- `GET /api/invite/:slug/image/footer` requires a valid `cire_session` **whose
  family belongs to this wedding** (`inviteService.sessionOwnsWedding` — a bare
  session only proves the holder claimed *some* household's code), and responds
  `Cache-Control: private`. It 404s rather than 401/403, so an unclaimed visitor
  cannot learn whether a closing image exists.

`hero` and `story` stay public and publicly cacheable; only `footer` is gated. It is deliberately NOT given the events section's
`opacity-0` class: the unlock choreography animates the events, and a section
that needs a motion chunk to become visible is a section that can stay invisible
when that chunk fails to load (the exact failure `UnlockReveal.motion.ts` warns
about). It sits below every event card, so it is off-screen while the reveal
plays.

**It has no tone setting of its own.** It paints the WELCOME section's surface
(`sectionVars(theme, "welcome")`, passed in as `themeVars`). The welcome
greeting and the closing note are the couple's two direct addresses to their
guests, so they read as a matched pair — and the builder gains no extra knob for
a section whose whole job is a sentence and an image. `THEME_SECTIONS` stays the
four lanes it has always had.

**It is NOT part of `SiteFooter`.** Two different things live at the bottom of
an invite and the distinction is load-bearing:

| | `InviteClosing.astro` | `SiteFooter.astro` |
|---|---|---|
| What | Invite content — the couple's closing image + note | Site chrome — couple's title + Privacy/Terms/Privacy-choices |
| Where | Only the invite, immediately above the footer | Every document (invite, `/privacy`, `/terms`, 404) |
| When | Conditional — nothing set ⇒ **renders nothing at all** | Always (compliance blocker C-H4) |
| Themed | Yes — reuses the **welcome** tone, no setting of its own | No — inherits the root palette |
| Gated | Yes — only after the guest claims their code | No — always |

The first implementation put the note and image *inside* `SiteFooter`. That was
wrong in three ways: it would have rendered invite content on the legal pages,
it left the couple's words stranded in a legal-links block instead of a section
of their own, and — because `SiteFooter` is outside the island — it exposed the
note to anyone with the URL, before any code was entered.

**Naming.** Storage and the wire say `footer_*` / `footer` (the image slot's R2
namespace and public URL segment too); the builder says "Closing Section". The
data-layer name is accurate — it IS the invite's footer section — but showing an
organiser "footer" beside a page that also has a legal footer would be ambiguous
about which one they're editing. Deliberate mapping, not drift.

On the note specifically: It is the one
copy field with **no built-in default**: it exists so a couple can add a closing
line of their own ("Looking forward to celebrating with you", "No boxed gifts
please"), and there is no sensible neutral sentence to invent on their behalf.
So it behaves like the conditional segments below rather than like the fields
above — blank means the line is simply not rendered, and every existing wedding
keeps today's footer (couple's title over the legal links) until an organiser
fills it in. Cap 300 chars, same as the welcome greeting.

Image slots: `INVITE_IMAGE_SLOTS = ["hero", "story", "footer"]`. The same union
bounds the `:slot` route param, the R2 key namespace, and the observability
span/log attributes (no free-form strings). Adding a slot is a conscious schema
change — and a wider one than it looks:

- **`SLOT_COLUMNS` in `cire/api/src/services/invite.ts`** is the one place the
  union maps onto storage (key column, crop column, and the hero-only mobile
  crop column). Every read/write indexes it. Before `footer` landed the service
  branched `slot === "hero" ? … : …` in five places, each of which would have
  silently treated a third slot as the story slot; the map exists so that class
  of bug can't recur.
- **`loadReferencedKeys` in `asset-reconcile.ts` must list the new key column.**
  This one is not a no-op if missed — that query is what marks an object LIVE,
  so an unlisted slot's images read as orphans and get swept after the grace
  window. Pinned by a reconcile test that seeds every slot.
- `CROP_ASPECT` in `cire/organiser/src/lib/image-crop.ts` needs the slot's
  default editor shape (`footer` is 16∶9 — it renders as a full-bleed closing
  hero band, so it opens on the same wide frame the hero does).

A `null` text field (or an all-whitespace value, which the service normalises to
`null`) means **use the built-in default** — so a partially-filled section still
renders the original hard-coded copy for the fields the organiser left blank.

## Conditional segments (empty ⇒ hidden)

A section that has **no content at all** is not shown on the guest invite — we
never paint an empty full-screen hero or an empty "Our Story" surface. "Absent"
means null, empty-string, **or whitespace-only** (typing only spaces does not
fill a field). The single source of truth for these predicates is
`cire/web/src/components/invite-emptiness.ts` (`hasText`, `isHeroEmpty`,
`isStoryEmpty`, `hasFooterMessage`, `isFooterEmpty`, `hasPinterest`,
`hasDressCode`).

| Segment                       | Rendered when…                                            | Where                                   |
| ----------------------------- | --------------------------------------------------------- | --------------------------------------- |
| **Hero** (full-screen)        | it has an image **OR** a title **OR** a subtitle          | `InviteHeader.tsx` (`showHero`)         |
| **Our Story**                 | it has a heading **OR** a body **OR** a story image        | `InviteHeader.tsx` (`showStory`)        |
| **Event → Inspiration**       | the event has a `pinterestUrl`                             | `DetailsModal.tsx` (`hasPinterest`)     |
| **Event → Dress Code**        | the event has a dress-code description **OR** a palette swatch | `DetailsModal.tsx` (`hasDressCode`) |
| **Closing section**           | it has a note **OR** an image (whole section), post-claim   | `InviteClosing.tsx` (`isFooterEmpty`)   |

Image-only or title-only heroes are valid (the neutral "You're Invited" fallback
title only renders **inside** an otherwise-shown hero). All built-in fallback
copy is deliberately NEUTRAL: the original bespoke defaults (the "V & R"
monogram and the couple's personal story text) were replaced 2026-07-10 — a
multi-tenant product must never default to one couple's content. A deployed
wedding that silently relied on those defaults must save its own copy via the
builder (the old values live in the PR #248 description). The Our-Story eyebrow is a
label, not content — it does not keep the section alive on its own.

**Builder reflection (no surprises):** `InviteBuilder.tsx` shows a per-section
badge — **"Shown"** vs **"Hidden — empty"** — on the Hero, Our Story and Closing
Section fieldsets,
driven by the **same** emptiness logic (mirrored in
`cire/organiser/src/lib/invite-emptiness.ts`, since the two packages share no
code). The badge updates **live** as the organiser types, so they know exactly
what a guest will see before saving. Keep the two predicate files in lockstep.

## Required event fields (Name + Start + Timezone)

The event/guest source of truth is the CSV import, not the builder. The required
set (`REQUIRED_EVENT_COLUMNS` in `cire/api/src/services/spreadsheet.ts`,
`parseEventsCsv`) is the minimum to render and order an event on the invite:
**Event Name, Start, Timezone**.

- The **header row** must contain every required column ⇒ otherwise
  `MissingRequiredColumn`; each **data row** must have a non-empty
  (non-whitespace) value for them ⇒ otherwise `MalformedSpreadsheet` with a
  specific reason + 1-indexed row/column (e.g. _"Start is required"_), shown in
  `ImportPanel.tsx` rather than a generic failure.

**End and Location are optional** (2026-07-08; previously both were required —
Location since `feat/invite-conditional-segments`):

- A blank/absent **End** stores the `""` no-stated-end sentinel in
  `events.end_at` (column stays `NOT NULL`, no rebuild). Consumers handle it:
  the invite's time range shows just the start (`formatTimeRange`), the
  organiser `EventTable` drops the "– end" suffix, calendar links fall back to
  a zero-duration entry (`calendar.ts` `effectiveEnd`), and the **retention
  sweep** compares `max(max(end_at, start_at))` so an all-open-ended wedding
  is aged by its start dates, never by `max("")`.
- **Location** was parsed-then-discarded (there is no `events.location` column —
  the "Where" + Open-in-Maps derive from **Address**, see
  `cire/web/src/components/event-details.ts`). It is now optional and, when
  provided with a blank Address, is written into `events.address` at
  import-apply time so the venue name actually reaches the invite.

The organiser-facing template mirror (`cire/organiser/src/lib/import-templates.ts`,
`EVENT_REQUIRED_HEADERS` / `EVENT_OPTIONAL_HEADERS`) lists End + Location under
the **optional** chips, kept in lockstep with the parser by
`import-templates.test.ts`.

## Theme (fonts + a five-colour scheme)

A second bounded surface on the same row: two global fonts (`headingFont`,
`bodyFont`), a **five-seed colour scheme**, and a per-section **tone**. Single
source of truth for the vocabulary: `@cire/theme` (`PALETTE_SEED_KEYS`,
`PALETTE_PRESETS`, `SECTION_TONES`, `FONT_CHOICES`), re-exported by
`cire/api/src/schemas/invite.ts` (`InviteThemeBody`).

### Why a scheme, not per-section colours

Until migration `0044` the builder asked for **eight** colours — an accent and a
surface for each of hero / story / details / welcome. That is eight chances to
pick a set that does not hang together, and it still only reached **five of the
guest site's thirteen design tokens**: the page background, borders, text, muted
text and the hero gradient were hard-locked, and hero + story applied only the
raw `--invite-*` variables (not the token bridge), so their `text-gold` /
`border-border` utilities silently ignored the organiser's accent entirely.

Now the organiser names five colours by their ROLE and `derivePalette` in
`@cire/theme` produces every other token from them, applied once at the document
root — so the scheme reaches every section, both modals, the footer and the hero
gradient.

| Seed    | Role on the invite | Drives                                                        |
| ------- | ------------------ | ------------------------------------------------------------- |
| `ground` | The page           | body background, hero base gradient, scrims                   |
| `card`   | Raised paper       | event cards, modals, panels, the code-entry box               |
| `ink`    | Everything written | headings, body, muted text, hairlines                         |
| `gilt`   | The metal          | rules, eyebrows, buttons, links, focus ring                   |
| `bloom`  | Festive counter    | dots, ornament, motifs, ambient accents                       |

The builder labels each picker with the **seed name** from that first column —
Ground, Card, Ink, Gilt, Bloom — and prints the "Drives" line beneath it. The
names mean nothing on their own, so the description is not decoration; but one
vocabulary across the UI, this page, `@cire/theme` and the API beats two.

`palettePreset` records which curated scheme (`evergreen` — today's look —
`jewel`, `fog`, `chapel`, `garden`) the organiser started from. It is
presentation only: the five seed columns are what render, and a `null` seed
falls back to that role's value in the preset, so picking a preset and nudging
one colour keeps the rest coherent.

### Tones replace per-section colour

Each section carries a `tone` — `ground` | `card` | `raised`, i.e. which derived
surface it sits on (`hero_tone`, `story_tone`, `details_tone`, `welcome_tone`;
`null` ⇒ `ground`). The closing section reuses the welcome tone rather than
adding a fifth — see above. Alternating surfaces down the page is what made sections read
as distinct; eight free colours were never what did that work. There is
deliberately no "sit on the accent" tone — that needs the text tokens to flip
too, and a half-flipped section is the unreadable output the derivation exists to
prevent.

### Contrast is enforced first, and warned about where it can't be

`derivePalette` moves a derived text or accent token's lightness until it clears
WCAG on the surface it actually sits on (4.5:1 for text, 3:1 for UI + focus), and
returns a well-chosen seed untouched. The builder reports what it moved
(`paletteAdjustments`) rather than warning and shipping an unreadable invite,
which is what the old `ContrastAdvisory` did. Derivation is direction-aware — it
pushes surfaces AWAY from `ground` — so one function produces a coherent dark
invite and a coherent light one with no `isDark` flag threaded through
components.

Enforcement runs each token against **one** backdrop, though — ink against card
and ground, muted against card, gilt against ground — because a token nudged to
clear every surface it might ever touch gets dragged to an extreme by the
hardest pair and stops looking like the organiser's colour. The surface left out
of that walk entirely is **`raised`**, which is derived as `card ± 0.05`
lightness, so a pair can clear against `card` and miss against `raised` by a
hair. `paletteContrastWarnings(tokens)` measures the residue on the **derived**
token map (never on the seeds, so the ratio quoted is the one a guest gets) and
the builder shows it under the scheme editor with the measured ratio and the bar
each pair missed.

**Each pair names the surface it measures**, and getting that wrong is the easy
mistake — the first cut had it crossed in both directions (measuring
`--color-surface` while the copy said "event cards", measuring `raised` while
saying "pop-ups"). On the guest site it is the other way round:

| Token | Where it is actually painted |
|---|---|
| `--color-surface` | the modal shell (`AnimatedModal`) and the RSVP sheet's sticky footer — everything on it is already enforced |
| `--color-surface-raised` | every `EventCard` and the RSVP sheet's notice block — carries the card title (`--color-text`), venue + description (`--color-text-muted`) and the date (`--color-gold`) |
| `--color-bg` | section backgrounds — muted section copy, the RSVP-by line |

Two deliberate calls in that table. **Muted text is held to 4.5:1, not the 3:1
UI floor the derivation uses**, because every `--color-text-muted` site on the
invite is small text (0.74–0.92rem) and printing "needs 3:1" beside a text pair
would state the wrong requirement to the organiser as fact. All five presets
clear 4.5 there, so it costs no false alarms. **`gilt-on-raised` is held to 3:1
even though its most prominent job is the event-card date** (0.92rem, i.e.
normal text at 4.5:1) — at 4.5 the curated `chapel` (3.58:1) and `garden`
(3.91:1) presets would warn out of the box, and a warning that fires on our own
shipped schemes teaches organisers to ignore it. That preset gap is real and
filed in `[[security]]`; the 3:1 bar still catches what this check exists for.
**`--color-bloom` has no pair at all** — it is a defined token with no render
site anywhere in `cire/web`, so a warning about it would concern a colour no
guest can see.

The warning panel is a **permanently-mounted** `role="status"` with its contents
conditional, not a `<Show>` wrapping the region: a live region inserted together
with its content announces unreliably, and this one's trigger is a pointer drag,
so wrapping it would mount/unmount the region and reflow the sidebar at frame
rate. Rows use `<Index>`, not `<For>` — `For` reconciles by item reference and
`paletteContrastWarnings` allocates fresh objects from a token map whose
identity changes every frame, so every row would be torn down and rebuilt per
pointermove. The ratios themselves are `aria-hidden`, since `role="status"` is
implicitly atomic and the numbers are the one part that moves continuously.

So the two notices answer different questions and neither stands in for the
other: `paletteAdjustments` says _what we changed for you_,
`paletteContrastWarnings` says _what we couldn't_. Both can be true at once — a
white page with a white card has its `ink` rescued AND still leaves modal text
just under 4.5:1 on `raised`. All five curated presets are clean, which is what
makes a non-empty warning worth reading. It warns rather than blocks: the fix
(usually moving `card` back toward `ground`) is a design decision the builder
cannot make for the organiser.

Two failures worth remembering, both caught only by screenshotting a light
scheme (regression-tested in `cire/theme/src/palette.test.ts`):

- a near-white card on a cream page **clipped** at white, so the `raised` tone
  rendered identically to `card`; the step now reverses when it would clip.
- the hero scrim was fixed-dark, which turned a cream invite muddy grey; it now
  tracks the page (dark page scrims dark, light page veils light).

### Typography options (heading size / weight / style + body weight / style)

Migration `0048` adds five **global** typography options alongside the two font
faces: `headingSize` (`small | large` — a multiplier on each pack's existing
`clamp(...)` curves), `headingWeight` + `bodyWeight` (`light | regular | bold`
→ 300/400/700), and `headingStyle` + `bodyStyle` (`normal | italic`). All are
**closed enum keys** (`HEADING_SIZE_CHOICES` / `FONT_WEIGHT_CHOICES` /
`FONT_STYLE_CHOICES` in `@cire/theme`), NULL ⇒ the design pack's built-in look.

`typographyVars` in `@cire/theme` — shared by the guest root vars and the
organiser preview — resolves each key to a fixed CSS value and emits
`--invite-heading-scale/-weight/-style` + `--invite-body-weight/-style` only
when set, so nothing new crosses the CSS-injection gate (the payload never
reaches a style; only the closed map's values do). Consumption: the packs'
hero-title + section-heading elements carry
`[font-weight:var(--invite-heading-weight,300)]`
`[font-style:var(--invite-heading-style,normal)]` and wrap their size clamps in
`calc(clamp(…)*var(--invite-heading-scale,1))` (fallbacks = the former literals,
so an unset option renders pixel-identical); the body pair is applied by
`global.css`'s `body` rule and cascades by inheritance, with headings pinning
their own weight/style so an italic body never drags the headings along. Modal
titles and event-card names deliberately keep the pack look. The weight
vocabulary stops at 300/400/700 because those are the faces Cormorant Garamond
AND Lato actually ship (no 500/600 in Lato — a `medium` step would faux-bold);
the guest + organiser font links load the 700s and true italics.

### Still bounded

- **Fonts** are a **closed enum** (`FONT_CHOICES`: `default`, `cormorant`,
  `lato`, `georgia`, `system-sans`, `system-mono`) — never a free-text font
  name / URL. `@cire/theme` owns the concrete `font-family` stack
  (`FONT_STACKS`); every key resolves to an **already-loaded** font (Cormorant
  Garamond / Lato) or a pure **system stack** — no new web-font / CDN
  dependency, no `@font-face`/SSRF surface, no render-block cost. This map used
  to exist in three hand-maintained copies (guest render, API enum, organiser
  preview); one copy is the point.
- **Typography options** are closed enums too (see above) — the persisted key
  is looked up in `@cire/theme`'s value maps on every side; an unknown key
  emits nothing and degrades to the built-in look.
- **Colours** pass a strict server-side allow-list (`isThemeColor`) — only
  `#hex` / `rgb(a)` / `hsl(a)` / `oklch(...)` with a restricted inner-character
  class (no `url()`, `expression()`, `var()`, named colours, or attribute
  breakouts), length-capped at 64. This is the **CSS-injection gate**: a bad
  seed ⇒ 400, never persisted. The guest site **re-validates** the same
  allow-list before deriving (`safeSeeds` in `invite-theme.ts`) — defence in
  depth, and a rejected seed degrades to the default preset rather than breaking
  the page. Every DERIVED value is emitted as `oklch(...)`, so it clears the same
  gate as a hand-picked one.
- **Tones and preset keys** are closed enums too, so neither can carry free text
  into rendered CSS or the builder's UI.

The **dress-code palette** on an event is deliberately NOT scheme-driven: those
swatches say what guests should wear, and recolouring them would be a lie.

## Storage

`wedding_invite_customisations` (`cire/db/src/schema.ts`, migrations
`0009_invite_customisations.sql` + `0014_invite_theme.sql` +
`0017_hero_display_options.sql`) — one row per wedding (`wedding_id` PK + cascade
FK ⇒ 1:1). Nullable text columns + nullable `hero_image_key` / `story_image_key` +
nullable theme columns (`theme_heading_font`, `theme_body_font`, the five
typography-option columns `theme_heading_size` / `theme_heading_weight` /
`theme_heading_style` / `theme_body_weight` / `theme_body_style` from
`0048_invite_typography.sql`, the five
`palette_{ground,card,ink,gilt,bloom}` seeds + `palette_preset`, and the four
`{hero,story,details,welcome}_tone` columns — all from
`0044_invite_palette.sql`, which dropped the eight
`{hero,story,details,welcome}_{accent,surface}_color` columns added by `0014` +
`0027`, back-filling the hero accent → `palette_gilt` and the hero surface →
`palette_card`) + the nullable copy columns
`details_eyebrow` / `details_heading` / `welcome_message`
(`0028_details_welcome_copy.sql`) + `footer_message`
(`0049_invite_footer_message.sql` — the footer's closing note, which unlike its
neighbours has no built-in default: NULL ⇒ nothing rendered) +
`footer_image_key` / `footer_image_crop` (`0050_invite_footer_image.sql` — the
closing section's optional full-bleed image, same R2-key + crop-JSON storage as the other
slots) + the two **hero display** columns
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

> The `cire-assets` bucket was created 2026-06-15 and is live. Recreating the
> account from scratch would need `bunx wrangler r2 bucket create cire-assets`.

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
  - `PUT /invite/text` → upsert the copy fields (total body — the builder always
    submits every key). Empty/whitespace ⇒ `null`, which means "use the built-in
    default" for every field except `footerMessage`, where it means "render
    nothing".
  - `PUT /invite/theme` → upsert the theme (fonts + the five-seed colour scheme
    + a per-section `tone`) **plus the
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

Named variants (not an arbitrary `?w=` / `?blur=`) are deliberate: the count is
exactly four per slot, which keeps the edge cache hot and stops an attacker
minting endless distinct transform URLs (a cache-poisoning / cost
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

> **Scoped token bridge (`sectionTokenBridge`).** Section states (input focus
> border, button hover fill, event-card date lines) live in Tailwind
> pseudo-class utilities that inline styles can't reach, so instead of
> per-element `var(--invite-accent, …)` styles the section wrapper
> **re-points the scoped Tailwind tokens** at the validated variables:
> `--color-gold: var(--invite-accent, <gold literal>)`, plus `--color-gold-dim`
> (a `color-mix` at the original 0.35 alpha), `--color-surface`,
> `--font-display` and `--font-body`. Every gold/surface/font utility inside
> the wrapper — including hover/focus — then follows the organiser's pick, and
> an unset variable falls through to the literal built-in token (a var()
> self-reference would be a cycle, hence the literals).
> `sectionTokenBridge(theme, section)` in `invite-theme.ts` is the shared
> helper; it styles the **welcome** wrapper (`LoginSection`, which keeps its
> `transparent` background default), the **events/details** wrapper in
> `InvitePage` (this is what makes the details accent reach the `EventCard`
> buttons — previously only the section header was themed), and — via the
> `AnimatedModal.themeVars` prop — the RSVP + event-details modals, which
> paint outside any themed section wrapper and would otherwise stay on the
> built-in tokens.

> **Render-boundary resilience.** `sectionThemeVars` reads the section sub-object
> defensively (`theme[section]?` → fall back to the built-in tokens) and never
> throws on a truthy-but-partial theme. This matters because the "details" map
> styles the **events** section wrapper, so a throw here would crash the
> `InvitePage` island and make the whole events list vanish. A malformed/partial
> payload now degrades to the default section colours rather than taking events
> down — mirroring the organiser preview helper's `?? default` behaviour.

Which wedding's customisation the guest site renders is resolved **from the
request path** (`/<slug>`) at render time — see the guest-rendering section
above. There is no `PUBLIC_WEDDING_SLUG`: the build-time variable was removed
when the invite route became path-routed SSR, so one deployment serves every
wedding from its own link.

## Organiser UI

`cire/organiser/src/components/invite/` (2026-07-30 split — the former
1,650-line `InviteBuilder.tsx` is now a directory; the old
`components/InviteBuilder.tsx` path survives as a re-export so import sites
and tests are unchanged). `useAuth().authFetch` drives the organiser
endpoints; `solid-toast` for feedback, `isAuthExpired` / `redirectToLogin` for
401 handling — same patterns as `ImportPanel`.

| File | Owns |
| --- | --- |
| `invite/InviteBuilder.tsx` | Orchestration: resource, draft store, save/upload/crop actions, layout, section tab state |
| `invite/model.ts` | Wire types, closed option sets, `COPY_CAPS` (client mirror of `InviteTextBody`), the `InviteDraft` shape + pure `textPayload`/`themePayload` builders |
| `invite/fields.tsx` | `TextField` / `TextAreaField` (live counters) / `ChoiceField` / `SliderField` (`aria-valuetext`) / `SegmentBadge` (`role="status"`) / `SectionCard` (`hidden` prop) / `Disclosure` / `InstantBadge` |
| `invite/previews.tsx` | `HeroSample`+`HeroPreview` (crop-aware, desktop/phone toggle), `SectionSample`+`SectionPreview`, `DeviceToggle` |
| `invite/PreviewPane.tsx` | The composed whole-invite preview markup (exports `PreviewPaneProps`) — sticky side pane at wide widths |
| `invite/PreviewModal.tsx` | The SAME composed preview in a mobile modal, opened by the "Preview" button beside the section tabs |
| `invite/DesignPicker.tsx` | Design radiogroup, roving tabindex, `aria-disabled` locked cards, thumbnails |
| `invite/ImageField.tsx` | Upload/crop/remove per slot, inline per-slot errors, remove confirm lives in the builder |
| `lib/unsaved-guard.ts` | Cross-component dirty registry; `OrganiserApp.setRoute` confirms before SPA navigation |

**Structure: one card per guest-page section, in the order guests scroll
them, each owning everything about its section — shown ONE AT A TIME, tabbed,
not stacked.** **Design** first, then a global **Look** fieldset (two font
`<select>`s and the colour scheme visible; the five typography-option
`<select>`s — heading size/weight/style, body weight/style, all closed
mirrors of the `@cire/theme` enums — behind a "Fine-tune typography"
disclosure), then **Hero** (preview at the TOP of the card so the sliders
below act on something visible; image + two crops, title/subtitle, tone, and
the three hero-display sliders behind a "Hero display" disclosure), **Our
Story**, **Code Entry & Welcome**, **Events Section**, **Closing Section**,
and finally the copyable **Invite message** (explicitly flagged as not part
of the guest page).

**The section nav is a real tab switcher (2026-07-30), not a scroll-jump
list.** The builder used to stack all eight cards in one long vertical page
with a sticky pill row that called `scrollIntoView` on click (`#hash` anchors
were never an option — the dashboard routes on `location.hash`, so a real
`#invite-hero` link would clobber it). That made the builder page longer than
it needed to be on every screen, and pinned the composed preview to a fixed
scroll position an organiser had to scroll back up to see. Now `activeSection`
(a signal in `InviteBuilder.tsx`) tracks which ONE section is showing; the nav
pills set it instead of scrolling, and mirror the sections' Shown/Hidden badge
state as dots, same as before.

**The ARIA tabs contract is complete, not just the roles.** The first cut
declared `role="tablist"`/`role="tab"`/`aria-selected` on the nav but left the
panel side of the relationship unwired — no `aria-controls`, no
`role="tabpanel"`, no `aria-labelledby`, and every tab sat in the normal `Tab`
sequence instead of a roving tabindex, which is worse than not using the role
at all: assistive tech is told "this is a tabs widget" and then doesn't get
tabs-widget behaviour (a security-review compliance finding, C-M1). Fixed to
the full [WAI-ARIA APG tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/),
hand-wired rather than migrated to Kobalte's `Tabs` primitive (a bigger,
riskier change to the `SectionCard`/`hidden`-attribute mount-persistence this
PR relies on, for a widget this codebase already hand-rolls elsewhere — see
`DesignPicker`'s roving-tabindex radiogroup, the pattern this mirrors):

- Each tab: `id={`${item.id}-tab`}`, `aria-controls={item.id}` (the panel's
  DOM id — already the fieldset's `id` prop), `tabIndex={active() ? 0 : -1}`.
- Each panel (`SectionCard`'s `<fieldset>`): `role="tabpanel"`,
  `aria-labelledby={`${props.id}-tab`}` — unconditional, since `SectionCard`
  has exactly one consumer (the eight tab sections), so there's no case where
  the tabpanel semantics would be wrong.
- Keyboard: `ArrowRight`/`ArrowLeft` step (wrapping), `Home`/`End` jump to the
  first/last tab — the APG "automatic activation" model, where moving focus
  ALSO activates the section (same model `DesignPicker`'s arrows use for
  selection). `sectionTabRefs` (a `Map<string, HTMLButtonElement>`) is the
  imperative-focus mechanism, since Solid has no roving-tabindex primitive.

**The tabs collapse into a menu on phones (2026-07-30).** Eight tabs cannot
share a line below `@3xl/builder` (48rem), and the first cut let the row scroll
horizontally: Closing and Message sat off the right edge with nothing to say so
— the exact failure `ModuleSidebar` had already fixed for the module strip, on
the surface where an organiser is least likely to go hunting. Below that
threshold the tabs now collapse behind a **trigger naming the current section**
— its label, its `n/8` position, and its Shown/Hidden dot, so the menu only has
to be opened to MOVE, never to orient — which opens them as a **two-column
grid**: all eight on screen at once (≈206px tall on a 390px phone, so nothing
scrolls), 44px touch targets, absolutely positioned against the sticky bar so
opening it overlays the form rather than shoving it down. From `@3xl/builder`
up the trigger is `display: none` and the tabs are the static row they have
always been — measured: at the crossover the eight pills plus the "Preview"
button fit one line with room to spare.

**One tablist, two presentations — not two tablists.** The narrow surface
re-lays-out the SAME `role="tablist"` rather than rendering a second copy of the
tabs inside a dialog (the shape `ModuleSidebar` uses, which is fine for a nav of
plain buttons and wrong here): each panel's `aria-labelledby` points at
`${id}-tab`, so a duplicate would give every panel two candidate labels and
assistive tech two tabs widgets for one set of panels. Collapsed, the tablist is
`display: none` — the panels' names still resolve, because accname follows
`aria-labelledby` into hidden subtrees. The container-query swap needs no
`ResizeObserver`; the only JS state is the open/closed signal, which is inert
above the threshold since the wide row ignores it (`@3xl/builder:flex` beats
both the `hidden` and `grid` toggles in the cascade — variants are emitted after
base utilities).

**Four dismiss paths, and one of them is a WCAG requirement.** Selecting a
section closes the menu **and hands focus back to the trigger** (collapsing takes
the focused tab to `display: none` and focus with it — a click with the menu
already closed, i.e. the wide row, leaves focus exactly where it was); `Escape`
closes and restores focus; an outside `pointerdown` closes it via a
capture-phase listener that exists only while open; and **focus leaving the nav
closes it** (`onFocusOut`, `relatedTarget` outside `sectionNav`). That last one
is not tidiness — without it, tabbing forward instead of selecting walks focus
into the first form control of the active section, which sits *behind* the
opaque overlay the open menu paints across the top of that section, with Escape
bound to the tabs and the trigger rather than to the field. WCAG 2.2 SC 2.4.11
*Focus Not Obscured*, and the "reveal without advancing focus" exception does
not apply (**SM-C-M1** in `[[security]]`).

A fifth closer is not a dismissal at all: the `ResizeObserver` that already
picks the preview layer also collapses the menu once the container crosses
`SECTION_MENU_REM` (48rem), because the trigger is the signal's only other
writer — left alone, a menu opened narrow stays "open" for the rest of the
session after a rotate or resize, and `selectSection` then focuses a
`display: none` trigger on every wide tab click (**SM-P-I1** in `[[perf]]`).

**Arrow keys follow the geometry, not the DOM order.** `ArrowLeft`/`ArrowRight`
step one, always. `ArrowDown`/`ArrowUp` are handled **only while the menu is
open** — on the wide single-line row APG reserves them for the browser, and
handling them there swallowed page scroll from a focused tab (**SM-C-L1**) — and
open, they step by `SECTION_MENU_COLUMNS`, not by one: in a row-major two-column
grid the next item is to the right and the one below is two along, so aliasing
Down to Right would make the arrows disagree with what the organiser can see
(**SM-C-L2**). Two columns are kept deliberately over a spatially-simpler single
column, which at ≈396px would overflow the `max-h-[60vh]` cap on a landscape
phone and re-introduce the very scrolling this replaced.

`SECTION_MENU_COLUMNS` is **exported**, and a test asserts the tablist's class
contains `grid-cols-${SECTION_MENU_COLUMNS}`. The class cannot be built from the
constant — Tailwind extracts utilities by scanning source **text**, so
`grid-cols-${…}` emits no CSS at all — so the literal and the constant are a
hand-maintained pair, and the drift guard is the checkable half. Same treatment
`auto-grid` / `page-frame` got.

The trigger's accessible name carries the Shown/Hidden state as a clause
("…, 3 of 8, hidden — empty. Choose a section") rather than leaving it to the
dot. The dot is `aria-hidden`, and an `aria-label` overrides subtree content, so
the `sr-only` span the tabs themselves use would be dropped here — without the
clause the collapsed trigger tells a sighted organiser three things and a
screen-reader one only two, which is exactly the claim the design rests on
(**SM-C-L3**).

**Sections stay MOUNTED — only visually hidden.** `SectionCard` (`fields.tsx`)
takes a `hidden` prop and applies it as the native HTML `hidden` attribute on
the `<fieldset>`, rather than the tab switch unmounting/remounting cards. This
matters for three things at once: the draft store and dirty-tracking are
builder-wide, not per-section, so nothing about them changes; every inline
preview (`HeroPreview`/`SectionPreview`) keeps updating live regardless of
which tab is active, so switching tabs never shows stale content; and it keeps
`InviteBuilder.test.tsx` unchanged for the many tests that read fields across
several sections in one flow — `getByLabelText`/`getByText` don't filter on
the `hidden` attribute, so those pass untouched. `getByRole` DOES exclude
hidden elements from the accessibility tree, so tests reaching for a hidden
section's button/role now switch tabs first (`openSection("Hero")` test
helper) — the one place this change touched the test file beyond the section
itself.

**Two preview layers, one markup source — plus a third presentation of the
composed one.** Inline per-section previews (`SectionPreview`/`HeroPreview`)
render under each card on narrow layouts; at the builder's wide container
breakpoint they hide and a **sticky composed `PreviewPane`** takes over — the
whole guest page as one continuous column (hero → story → welcome → events →
closing) on its tone surfaces, with a desktop/phone frame toggle, so the tone
rhythm down the page is visible while editing. Both layers share
`HeroSample`/`SectionSample` and are styled with the SAME derived tokens the
guest consumes (`derivePalette` + `typographyVars` from `@cire/theme`,
resolved once in the `previewTokens` memo — and shared into `PaletteField`
via its `tokens`/`adjustments` props, so the whole builder derives exactly
once per colour-drag frame). Both layers stay permanently mounted with a
CSS-only container-query switch — a deliberate trade (one markup source, no
`ResizeObserver`) accepted as `P-I1` in `wiki/todo/perf.md` (cire wiki). The
`url("…")` sink both layers' crop rendering shares (`cropBackgroundStyle`,
lockstep organiser + guest copies) escapes its URL argument at the sink
(S-L1). The hero preview is **crop-aware** (saved rectangles render via the
guest's background-fraction technique — the framing never lies) and the phone
frame uses the hero's phone rectangle, falling back to the desktop crop
exactly as the guest site does. Tone pickers render **as their surface**
(swatch buttons on the scoped tokens), not as text-only chips.

**Mobile preview modal (2026-07-30).** Below `@4xl/builder` there is no room
for the sticky side pane, and the inline per-section previews only ever show
the ACTIVE section. A "Preview" button next to the section tabs (hidden once
the sticky pane can show instead — the same `@4xl/builder` CSS threshold, so
the two never both offer a way in) opens `invite/PreviewModal.tsx`: the exact
same `PreviewPane` in a `<Portal>` dialog, so there is still only one composed
markup source, just two presentations of it. `InviteBuilder.tsx` shares the
`hero`/`story`/`welcome`/`events`/`closing` slot values between the sticky
`<aside>` and the modal via five small per-slot helpers
(`heroPreviewProps(d)`, `storyPreviewProps()`, …), each called at its own JSX
prop position on BOTH consumers — e.g. `hero={heroPreviewProps(d)}` on both
`<PreviewPane>` and `<PreviewModal>` — so a change to one slot's shape can't
silently skip the other consumer. **Not** a single function returning the
whole `PreviewPaneProps` object spread with `{...}` onto each consumer — that
was the first cut, and it shipped a real live-preview regression (caught by
`InviteBuilder.test.tsx`'s "opens the composed preview in a modal…" test, not
by inspection): Solid's compiler makes an individual JSX prop reactive by
wrapping its expression in a getter, so `hero={heroPreviewProps(d)}`
re-evaluates every time `props.hero` is read inside a tracking scope. A
spread of an already-computed plain object has no such getter — the object
is built once, when the `<Show>` render-prop runs, and both the aside AND
the modal would freeze at whatever the form looked like on first render.

**Mobile preview proportions (2026-07-30 fix).** `HeroSample`'s title used
`font-size: clamp(1.25rem, 6vw, 2rem)` — `vw` resolves against the real
browser viewport, which is correct for the guest site's actual full-bleed hero
but wrong for a preview: the organiser's screen is wide even when previewing
the "Phone" frame, so the title rendered pinned at the clamp's 2rem ceiling
regardless of how small the preview box (a 12rem phone toggle, a 10rem inline
card) actually was — badly out of proportion with everything else in the
frame. Fixed by making `HeroSample`'s own root the query container
(`class="@container"`, unnamed — no descendant needs to name it) and switching
the clamp to `9cqi`, so the title scales off the box it is actually rendered
into. `previews.test.tsx` pins the new curve.

**Every preview sample follows the typography variables — none hardcodes a
look.** A sample that pins `font-light italic` in a class renders the same
whatever the organiser picks, so it doesn't merely fail to update: it
contradicts an explicit "Bold" / "Normal" pick made inches away. Each heading
sample therefore carries
`font-size: calc(<its clamp> * var(--invite-heading-scale, 1))`,
`font-weight: var(--invite-heading-weight, 300)` and
`font-style: var(--invite-heading-style, normal)` — the guest packs' literals
as fallbacks, so an un-set option renders exactly as before. The **body** pair
(`--invite-body-weight` / `--invite-body-style`) rides each sample's WRAPPER
beside `--font-body` and cascades to every line inside it, mirroring how
`global.css` applies it to the guest `<body>`; declaring it on the one body
line instead left the eyebrow and the mini event card on the pack default. This
applies to the third preview layer too — `PaletteField`'s "Colour scheme
preview", which sits directly under the Look card's typography controls and was
the one sample still hardcoded (fixed 2026-07-30).

The body pair is written as **Tailwind arbitrary properties**
(`[font-weight:var(--invite-body-weight,400)]`), the idiom the guest packs
already use for their heading elements, rather than as inline style. Heading
samples use inline style, because they resolve their values from `@cire/theme`
(below) and a class name cannot be built at runtime.

### The fallbacks are single-sourced too

`typographyVars` has always been the one place a **set** option resolves to a
value. The **un-set** state — the pack's own base look, written as each `var()`
fallback — used to be a literal retyped at every call site, ~30 references
across the two packs, the guest `global.css` and the previews, with nothing
checking they agreed. A pack changing its base heading weight would have left
every organiser preview misrepresenting "Default": the bug above, one level
down (was `T-S3`).

`@cire/theme` now names them once — `TYPOGRAPHY_FALLBACKS`, with
`typographyVar("headingWeight")` → `var(--invite-heading-weight, 300)` and
`headingSizeCss(base)` → `calc(<base> * var(--invite-heading-scale, 1))`, so a
pack keeps its own responsive curve and only the multiplier is shared.
`TYPOGRAPHY_VAR_NAMES` is the one spelling of the property names, and
`TYPOGRAPHY_VAR_KEYS` derives from it.

**Who can consume them, and who cannot.** The organiser's preview samples build
their declarations at runtime, so they call the helpers and hold no literal.
The guest packs CANNOT: their declarations are Tailwind arbitrary-property
classes, and Tailwind generates CSS by scanning source **text** — an
interpolated class name produces no rule at all. The same applies to the
previews' class-based body pair. Those references stay literal by necessity and
are held to the canonical values by `cire/theme/src/typography-fallbacks.test.ts`,
which scans both packages and fails on a fallback that disagrees, a reference
that omits its fallback (a bare `var()` renders at the CSS initial weight, not
the pack's 300), or a variable no consumer references any more.

> **Testing note.** Resolving a value through a helper makes Solid treat that
> style object as computed, and it then applies those declarations via
> `setProperty` — where happy-dom discards a `var()` value for `font-weight`,
> `font-style` and `font-size`. Assertions therefore go through
> `src/test-support/declared-style.ts`, which merges what Solid compiled into
> the template attribute with what it set at runtime. It is a test-environment
> limitation, not a browser one; do not reshape a component to work around it.

**One save, dirty-checked per half — and dirty state is REACTIVE.** The draft
lives in one `createStore` (`InviteDraft`); each half's serialised payload is
compared in a memo against the last server-acknowledged snapshot (a signal,
seeded on load, refreshed per successful PUT). That memo drives the sticky
save bar: the button **disables when clean**, a live **"Unsaved changes" /
"All changes saved"** indicator replaces the old click-to-find-out toast, and
a dirty draft is guarded against loss twice — `beforeunload` on tab
close/reload, and `lib/unsaved-guard` lets `OrganiserApp.setRoute`
`confirm()` before any in-app navigation unmounts the builder (browser
Back/Forward deliberately bypasses it). Each dirty half is **skipped when
unchanged**: a copy-only edit PUTs only `/invite/text`, a colour-only edit
only `/invite/theme`, and a no-op save is unreachable from the UI.
This keeps writes proportional to actual changes (P-W1) and pairs with the
server-side split below: since migration `0029` the guest image-cache
version is a dedicated `images_updated_at` column — bumped only by image
upload/remove/crop and a `heroBlur` change (the one theme field that alters
the served bytes), backfilled from `updated_at`, coalesced to it when NULL —
so copy/colour saves never bust the per-variant transform cache or force
guests to re-download the hero (WT-P-I1; transforms are the metered resource,
see the root `[[wiki/runbooks/free-tier-limits]]`). Dirty halves run sequentially (text
then theme), mutating the loaded data after each success — the API's
two-endpoint split is an implementation detail the organiser never sees.
(Before the restructure the builder had separate "Save copy" / "Save theme"
buttons with the hero sliders saved by the distant theme button — the source
of a "saved but didn't stick" class of confusion.) A text-half failure stops
before the theme PUT and shows that error; a theme-half failure shows its own.
The builder is wrapped in a real `<form onSubmit>`, so Enter in any field
saves.

**Two persistence models, marked.** Text/theme wait for Save; images, crops
and the design selection apply to the LIVE invite immediately. Every
instant-apply control carries an "applies immediately" badge, image
**removal is confirm-gated** (the one destructive, undo-less control), and an
upload/remove failure surfaces **inside its own section card**
(`role="alert"` next to the control), not in the distant save bar — only save
failures live there. Copy fields enforce the server caps client-side
(`maxlength` + live counters from `COPY_CAPS`, kept in lockstep with
`InviteTextBody`), so the 300-char closing-note limit is a counter, not a 400.
A true draft→publish model that would unify the two persistence models needs
API/schema support — tracked in `wiki/todo/deferred.md` (cire wiki), along
with an `updatedAt` concurrent-edit guard (the GET payload doesn't expose a
row version yet).

**Locked designs are perceivable.** Premium cards without the entitlement use
`aria-disabled` — never `disabled` — so they stay in the accessibility tree:
keyboard arrows land on them (announcing "Locked"), Tab order keeps one stop,
selection and click no-op, and the server enforces the entitlement regardless.
Per-section **"Reset section"** actions revert a card's saveable fields to
defaults as a draft change (nothing saved until the save bar says so).

The five scheme seeds use the popover pickers (`PaletteField.tsx` over
`ColorPicker.tsx`,
Kobalte ColorArea + hue slider + labelled hex field) each with a "Use default"
clear (null ⇒ built-in token). The picker only emits a full `#rrggbb` — never
partial input, and never mid-typing — so the UI can never submit a colour the
server allow-list would reject.

**The hex field is a plain `<input>`, deliberately not Kobalte's `ColorField`.**
Nothing shorter than six digits is ever a decision: en route to `#d4af37` the
partial `#d4a` is valid 3-digit shorthand, and committing it expands to
`#DD44AA` and yanks the swatch, preview and trigger to a colour nobody chose.
Guarding our own commit path is not enough — `ColorField` runs its **own** blur
handler that parses whatever is in the field and writes the expansion back, and
because Kobalte composes handlers with `composeEventHandlers` (which calls every
handler unconditionally, ignoring `preventDefault`) that handler cannot be
pre-empted from outside. It fired whenever focus left the field: clicking the
area, the next picker, or anywhere outside the popover. Owning the input means
owning the rule — `onHexBlur` re-prints a committed hex in canonical form and
restores the last committed colour for anything incomplete, so leaving a
half-typed entry never invents a colour. The cost is that 3-digit shorthand no
longer expands; that is the deliberate trade, since every full hex passes
through its own three-digit prefix on the way in.

**Hero phone crop (migration `0046`).** The hero is the one full-bleed image
rendered at both wide-desktop and tall-phone aspects, so a single rectangle
can't frame both — subjects framed to the side of a wide crop fell outside the
tall centre-cover window on mobile. The hero therefore carries **two**
rectangles: the existing `hero_image_crop` governs the guest packs' `md:`
breakpoint and up, and `hero_image_crop_mobile` (same JSON shape, hero-only)
governs narrower viewports, **falling back to the desktop rectangle when
unset** so every pre-0046 invite renders unchanged. Saves go through the same
`PUT …/invite/image/hero/crop` route with an optional `screen: "desktop" |
"mobile"` body field (default `desktop`; `mobile` on any other slot or the
event crop route is a 400). Guest-side the packs render one focal cover layer
per breakpoint (`heroCropLayers` + `heroImgRevealClass` in
`cire/web/src/components/image-crop.ts`); builder-side the hero `ImageField`
gains a "Phone crop" button opening the same modal on a tall `hero-mobile`
9∶16 default aspect, plus a phone-shaped WYSIWYG thumbnail. Upload/remove of
the hero image resets **both** rectangles.

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

**Live theme preview.** Every preview surface updates **instantly** as the
organiser edits — colour, font, typography option or copy — so they SEE the
effect before saving (originally a change only showed on the guest URL after a
save). There is no organiser-side theme mirror any more: `previewTokens` in
`InviteBuilder.tsx` calls the SAME `derivePalette` + `fontStack` +
`typographyVars` from `@cire/theme` that the guest root vars are built from
(`paletteRootVars` in `cire/web/src/components/invite-theme.ts`), so the preview
cannot disagree with what a guest sees. The one map is derived once per frame
and threaded to all three layers — the inline `SectionPreview`/`HeroPreview`
cards, the composed `PreviewPane`, and `PaletteField`'s scheme sample (via its
`tokens` / `adjustments` props). What each sample must keep in lockstep is not a
copy of the mapping but the **consumption**: the `var(--invite-*, <pack
literal>)` declarations above.

## Observability

cire/api uses `@shared/observability` (workerd-safe subpaths) — see
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
