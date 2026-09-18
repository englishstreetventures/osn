# Pulse Design System

Visual language and design decisions for the Pulse events app.

## Design Direction

Pulse takes functional cues from **Eventbrite** (info-dense event cards) with visual warmth from **Luma**, **Partiful**, and **Flighty** (editorial type, warm accents, playful glyphs). The result should feel modern and fun — not corporate.

## Typography

Three font families, all SIL Open Font License 1.1 (free commercial use):

| Role                | Family           | Weight range         | Usage                                                     |
| ------------------- | ---------------- | -------------------- | --------------------------------------------------------- |
| Display / editorial | Instrument Serif | 400 regular + italic | Hero headlines, section headers, stat numbers, map labels |
| UI / body           | Geist            | 400–700              | Navigation, card body, form labels, buttons               |
| Mono / data         | Geist Mono       | 400–500              | Timestamps, stat labels, category tags, eyebrow text      |

**Key type patterns:**

- Hero headline: Instrument Serif, `clamp(32px, 4.4vw, 56px)`, italic accent word
- Section headers: Instrument Serif, 22px, weight 400
- Card titles: Geist, 16.5px, weight 600
- Meta/eyebrow text: Geist Mono, 10.5–11.5px, uppercase, wide tracking
- Date stamps: Geist, mixed weights (9–18px depending on element)

### Named type tokens

Each Pulse surface names its own off-scale type decisions in its own theme block.
None of them belong in the shared `ui-*` contract, which is library-facing — an
app's headline measure and its eyebrow size are that app's, not every consumer's.

`@pulse/landing` — `pulse/landing/src/styles/global.css` (`@theme`):

| Token                    | Utility                | Value     | Sets                                                                                                                  |
| ------------------------ | ---------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| `--text-tag`             | `text-tag`             | `0.6rem`  | The uppercase mono category tag — on a floating chip, on a feature card, above the venue list                         |
| `--text-meta`            | `text-meta`            | `0.65rem` | The mono meta line beneath a chip tag                                                                                 |
| `--text-eyebrow`         | `text-eyebrow`         | `0.72rem` | The mono micro tier the sections are set in: every section eyebrow, and the set time in a venue row                   |
| `--text-copy`            | `text-copy`            | `0.95rem` | Body copy — an FAQ answer, a step description, a feature card, a button label                                         |
| `--text-lede`            | `text-lede`            | `1.05rem` | The line that introduces a block, and anything promoted above copy: a section lede, an FAQ question, a headliner slot |
| `--text-subhead`         | `text-subhead`         | `1.25rem` | A step's own heading, below the section headline                                                                      |
| `--text-glyph-sm`        | `text-glyph-sm`        | `2rem`    | A glyph in a 56px category tile                                                                                       |
| `--text-glyph-lg`        | `text-glyph-lg`        | `3rem`    | A feature card's glyph, and a how-it-works numeral                                                                    |
| `--tracking-mono-wide`   | `tracking-mono-wide`   | `0.14em`  | Mono caps at body length — the location line                                                                          |
| `--tracking-mono-wider`  | `tracking-mono-wider`  | `0.18em`  | Mono caps on a chip tag or a card label                                                                               |
| `--tracking-mono-widest` | `tracking-mono-widest` | `0.28em`  | Mono caps as a section eyebrow                                                                                        |
| `--leading-display`      | `leading-display`      | `1.05`    | Instrument Serif at hero size, and the closing call to action                                                         |
| `--leading-heading`      | `leading-heading`      | `1.2`     | A section headline, set around a third of the hero                                                                    |
| `--leading-copy`         | `leading-copy`         | `1.75`    | Long-form marketing copy at a 40rem measure                                                                           |

`--text-tag` and `--text-meta` sit below the smallest step of any scale available
here — Tailwind's own `text-xs` is 12px, and these are 9.6px and 10.4px.
Snapping them up would change the hero rather than tidy it, which is why they
are named.

The steps from `eyebrow` to `glyph-lg` replace **53 literal `text-[…]`,
`tracking-[…]` and `leading-[…]` values across 23 distinct sizes** in the seven
`src/components/sections/*.astro` files. 23 for one marketing page was itself the
finding: `1.02rem` and `1.05rem` were 0.48px apart and are one step here, as are
`0.72rem` and `0.8rem`, and `1.7`/`1.75`/`1.8` leading.

**They are named rather than snapped to a built-in step, even where one sits
within a pixel.** A built-in `text-*` also sets `line-height`; an arbitrary
`text-[…]` sets font-size alone. So `text-[0.9rem]` → `text-sm` would have
changed the leading too, on every site carrying no `leading-*` of its own — a
second, invisible change, and in different directions on different sites. A
`@theme` entry with no `--line-height` companion emits `font-size` alone, which
is what these are replacing. Built-in _leading_ utilities have no such coupling
and `leading-relaxed` is used directly.

The three tracking steps continue past where the default scale stops (`widest`
is 0.1em). Mono caps at these sizes need one and a half to three times that
before the letters read as spaced rather than collided.

Two things in those files are deliberately **not** on the scale. The five
identical `text-[clamp(1.9rem,4.5vw,3rem)]` section headlines read a size decided
at the viewport, which is what `clamp()` is for and which the arbitrary-value
rule exempts by name. And the literal `font-size` / `line-height` declarations in
the `<style>` blocks of `SiteFooter.astro` and `LegalLayout.astro` are CSS rather
than utilities — a separate piece of work, and not what #1117 scoped.

Nothing enforces this from the linter. `shadcn/no-arbitrary-values` is at
`error`, but `oxlintrc.json` lists `*.astro` under `ignorePatterns`, so oxlint
never parses the files this scale exists for — which is how 53 literals
accumulated behind a green rule. `pulse/landing/tests/named-type-scale.test.ts`
is the guard instead: it fails on a literal type value anywhere under `src/`, and
on a `@theme` entry going missing.

`@pulse/web` — `pulse/web/src/app.css` (`@theme inline`):

| Token                   | Utility          | Value   | Sets                                      |
| ----------------------- | ---------------- | ------- | ----------------------------------------- |
| `--container-hero`      | `max-w-hero`     | `16ch`  | The explore hero headline's measure       |
| `--spacing-accent-word` | `mr-accent-word` | `0.2em` | Optical gap before the italic accent word |

The hero measure is counted in characters rather than rem because a display
line's length is a property of the face it is set in, and the `ui-*` measure
scale is in rem.

## Color System

Built on oklch for perceptual uniformity. Extends the base shadcn token system with Pulse-specific accent tokens.

### Pulse accent — coral/ember family

| Token                   | Value                                                        | Usage                                                         |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `--pulse-accent`        | `oklch(0.68 0.18 38)`                                        | Primary accent (coral) — brand mark, hero italic, CTA buttons |
| `--pulse-accent-strong` | `oklch(0.58 0.19 35)`                                        | Ember — date stamp month, meta-line text                      |
| `--pulse-accent-soft`   | `oklch(0.95 0.05 45)`                                        | Peach background — soft highlight surfaces                    |
| `--pulse-accent-fg`     | Light: `oklch(0.99 0.004 80)` / Dark: `oklch(0.17 0.008 60)` | Text on accent backgrounds                                    |

### Semantic tokens

| Token            | Value                  | Usage                              |
| ---------------- | ---------------------- | ---------------------------------- |
| `--close-friend` | `oklch(0.66 0.16 145)` | Green ring on close-friend avatars |
| `--badge-live`   | `oklch(0.72 0.17 22)`  | Live event indicator dot           |

### Warm-tinted neutrals

Light and dark modes use **warm-tinted greys** (hue 60–80) instead of pure neutral. This gives the app warmth without explicit color.

### Shadows

Three tiers: `--shadow-sm`, `--shadow-md`, `--shadow-lg` — warm-tinted in light mode, deep black in dark mode.

## Explore Page Layout

Two-pane desktop layout:

- **Events pane** (~56%): scrollable feed — filter rail, sectioned card list
- **Map pane** (~44%): sticky, full-height — heatmap canvas, event pins, time scrubber

Below 1180px, map collapses and events go full-width.

### Navigation

Horizontal top nav (no sidebar). Three sections:

1. **Brand row**: Logo mark (pulsing coral dot) + "Pulse" wordmark, tab bar (Home / Calendar / Hosting), search, actions
2. **Hero**: Time-of-day greeting, editorial headline with italic accent word, live stats

### Event Cards

Horizontal card: 180px media thumbnail + body. Featured cards go full-width with taller media.

**Media area**: Category-derived gradient placeholder (or image), date stamp (month/day/weekday), status tag (live/filling fast).

**Body area**: Time meta-line (mono), title (600 weight), venue + neighborhood, host row with avatar, dashed footer with category and status.

**Placeholder system**: 8 gradient classes (`ph-1` through `ph-8`) with overlay pattern and category glyph — used when events lack an image.

### Map

- SVG-based stylized map (not real tiles) — neighborhoods, water features, park
- Canvas heatmap overlay — radial gradients from event coordinates, intensity weighted by time proximity
- Category-colored pins with glyph icons
- Time scrubber: range slider (0–23h) with serif hour display
- Hover popups on pins
- Legend card showing heat scale

## Component Catalog

| Component             | File                                 | Props                                                                                     |
| --------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `ExploreNav`          | `explore/ExploreNav.tsx`             | `query`, `onQueryChange`, `eventCount?`, `liveCount?`                                     |
| `FilterRail`          | `explore/FilterRail.tsx`             | `active`, `onSelect`                                                                      |
| `ExploreCard`         | `explore/ExploreCard.tsx`            | `event: EventItem`, `featured?`, `hovered?`, mouse handlers                               |
| `ExploreMap`          | `explore/ExploreMap.tsx`             | `events: EventItem[]`, `hoveredId?`, `onHoverEvent?`                                      |
| `ExplorePage`         | `explore/ExplorePage.tsx`            | (route component)                                                                         |
| `Icon`                | `components/Icon.tsx`                | `name`, `size?` (promoted from `explore/`; includes `globe`, `instagram`)                 |
| `VenueDetailPage`     | `pages/VenueDetailPage.tsx`          | (route component — `/venues/:orgHandle/:venueHandle`)                                     |
| `VenueLineupTimeline` | `components/VenueLineupTimeline.tsx` | `slots`, `timezone`, `heading?` — vertical mono-time timeline, headliner weight by `role` |
| `VenueEventCarousel`  | `components/VenueEventCarousel.tsx`  | `events`, `heading?` — CSS scroll-snap carousel with chevron paging                       |

## Design Decisions

1. **No sidebar** — horizontal tabs feel less corporate; the hero section gives the page personality
2. **Warm neutrals** — oklch hue 60–80 on all greys; distinguishes Pulse from generic shadcn apps
3. **Editorial serif** — Instrument Serif for headlines creates the Luma/Partiful editorial feel
4. **Glyph placeholders** — events without images get category-colored gradients + serif glyphs instead of grey boxes
5. **Heatmap over real tiles** — stylized SVG map avoids tile provider dependency; heatmap shows where activity clusters
6. **Card ↔ map hover sync** — hovering a card highlights its map pin and vice versa
7. **Category badges are eyebrows** — a category pill takes `@shared/ui`'s
   `Badge treatment="eyebrow"` (small caps, a step down in size, tracked to
   match) rather than upper case and tracking spelled out beside it. The three
   only work together, so they travel as one name

## Onboarding illustrations

The first-run flow (`/welcome`) introduces six themed SVGs in `pulse/web/src/assets/onboarding/`. They follow these rules so theme tokens drive every accent — no hard-coded colours, dark-mode automatic.

| Illustration           | File                            | Token usage                                                                                                                       |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Welcome pulse rings    | `welcome-pulse.svg`             | `--pulse-accent`, `--pulse-accent-soft`, `--pulse-accent-strong`. Rings animate via `.pulse-ring` keyframes in `onboarding.css`.  |
| Editorial map          | `value-map.svg`                 | `currentColor` for blocks, `--pulse-accent` family for pins + heat blob. Same vocabulary as `ExploreMap.tsx`.                     |
| Interest constellation | `interests-glyphs.svg`          | Instrument Serif glyphs; selectable chips render their own per-category glyph from `CategoryGlyph.tsx` (also `currentColor`).     |
| Location pin           | `location-pin.svg`              | Pin animates with `.location-pin-drop` (drop + bounce) and `.location-pin-ring` (radiate).                                        |
| Notifications ember    | `notifications-ember.svg`       | Coral envelope with two staggered radiating rings.                                                                                |
| Finish date stamp      | inline JSX in `Step6Finish.tsx` | Same date-stamp vocabulary as the Event Card; today's date is driven by `Date.toLocaleDateString` so the image is always current. |

Authoring rules:

- Use `currentColor` for primary strokes that should track text colour.
- Use `var(--pulse-accent*)` for the editorial accent — never inline `oklch(...)`.
- All animation is CSS keyframes only (no Lottie/Rive). Honour `prefers-reduced-motion` — see `onboarding.css` for the canonical opt-out rule.
- Per-category glyphs live as inline JSX paths in `CategoryGlyph.tsx`, not as separate SVG files. Single import, single recolour surface via `currentColor`.

Greeting copy on the welcome step uses the institutional headline ("Welcome to Pulse") with a softer personalised subhead ("Glad you're here, {displayName}.") so a missing displayName degrades to just the headline rather than a literal "Hi there".

## Future

- Friend avatar clusters on cards (needs social graph API integration)
- RSVP counts in card footer (needs list-level enrichment endpoint)
- Price display (needs schema addition)
- Real map tile integration (Mapbox/MapLibre) replacing SVG prototype
- Dark mode toggle in nav (design supports it; token system is ready)
