# Pulse Design System

Visual language and design decisions for the Pulse events app.

## Design Direction

Pulse takes functional cues from **Eventbrite** (info-dense event cards) with visual warmth from **Luma**, **Partiful**, and **Flighty** (editorial type, warm accents, playful glyphs). The result should feel modern and fun — not corporate.

## Typography

Three font families, all SIL Open Font License 1.1 (free commercial use):

| Role | Family | Weight range | Usage |
|------|--------|-------------|-------|
| Display / editorial | Instrument Serif | 400 regular + italic | Hero headlines, section headers, stat numbers, map labels |
| UI / body | Geist | 400–700 | Navigation, card body, form labels, buttons |
| Mono / data | Geist Mono | 400–500 | Timestamps, stat labels, category tags, eyebrow text |

**Key type patterns:**
- Hero headline: Instrument Serif, `clamp(32px, 4.4vw, 56px)`, italic accent word
- Section headers: Instrument Serif, 22px, weight 400
- Card titles: Geist, 16.5px, weight 600
- Meta/eyebrow text: Geist Mono, 10.5–11.5px, uppercase, wide tracking
- Date stamps: Geist, mixed weights (9–18px depending on element)

## Color System

Built on oklch for perceptual uniformity. Extends the base shadcn token system with Pulse-specific accent tokens.

### Pulse accent — coral/ember family

| Token | Value | Usage |
|-------|-------|-------|
| `--pulse-accent` | `oklch(0.68 0.18 38)` | Primary accent (coral) — brand mark, hero italic, CTA buttons |
| `--pulse-accent-strong` | `oklch(0.58 0.19 35)` | Ember — date stamp month, meta-line text |
| `--pulse-accent-soft` | `oklch(0.95 0.05 45)` | Peach background — soft highlight surfaces |
| `--pulse-accent-fg` | Light: `oklch(0.99 0.004 80)` / Dark: `oklch(0.17 0.008 60)` | Text on accent backgrounds |

### Semantic tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--close-friend` | `oklch(0.66 0.16 145)` | Green ring on close-friend avatars |
| `--badge-live` | `oklch(0.72 0.17 22)` | Live event indicator dot |

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

| Component | File | Props |
|-----------|------|-------|
| `ExploreNav` | `explore/ExploreNav.tsx` | `query`, `onQueryChange`, `eventCount?`, `liveCount?` |
| `FilterRail` | `explore/FilterRail.tsx` | `active`, `onSelect` |
| `ExploreCard` | `explore/ExploreCard.tsx` | `event: EventItem`, `featured?`, `hovered?`, mouse handlers |
| `ExploreMap` | `explore/ExploreMap.tsx` | `events: EventItem[]`, `hoveredId?`, `onHoverEvent?` |
| `ExplorePage` | `explore/ExplorePage.tsx` | (route component) |
| `Icon` | `explore/icons.tsx` | `name`, `size?` |

## Design Decisions

1. **No sidebar** — horizontal tabs feel less corporate; the hero section gives the page personality
2. **Warm neutrals** — oklch hue 60–80 on all greys; distinguishes Pulse from generic shadcn apps
3. **Editorial serif** — Instrument Serif for headlines creates the Luma/Partiful editorial feel
4. **Glyph placeholders** — events without images get category-colored gradients + serif glyphs instead of grey boxes
5. **Heatmap over real tiles** — stylized SVG map avoids tile provider dependency; heatmap shows where activity clusters
6. **Card ↔ map hover sync** — hovering a card highlights its map pin and vice versa

## Onboarding illustrations

The first-run flow (`/welcome`) introduces six themed SVGs in `pulse/app/src/assets/onboarding/`. They follow these rules so theme tokens drive every accent — no hard-coded colours, dark-mode automatic.

| Illustration | File | Token usage |
|--------------|------|-------------|
| Welcome pulse rings | `welcome-pulse.svg` | `--pulse-accent`, `--pulse-accent-soft`, `--pulse-accent-strong`. Rings animate via `.pulse-ring` keyframes in `onboarding.css`. |
| Editorial map | `value-map.svg` | `currentColor` for blocks, `--pulse-accent` family for pins + heat blob. Same vocabulary as `ExploreMap.tsx`. |
| Interest constellation | `interests-glyphs.svg` | Instrument Serif glyphs; selectable chips render their own per-category glyph from `CategoryGlyph.tsx` (also `currentColor`). |
| Location pin | `location-pin.svg` | Pin animates with `.location-pin-drop` (drop + bounce) and `.location-pin-ring` (radiate). |
| Notifications ember | `notifications-ember.svg` | Coral envelope with two staggered radiating rings. |
| Finish date stamp | inline JSX in `Step6Finish.tsx` | Same date-stamp vocabulary as the Event Card; today's date is driven by `Date.toLocaleDateString` so the image is always current. |

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
