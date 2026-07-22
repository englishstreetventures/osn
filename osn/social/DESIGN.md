# Design — OSN Social

A locked design system for the `@osn/social` app. Every screen reads this file
before it changes visual style. Do not regenerate per page — extend or amend
this file when the system needs to grow.

The system is deliberately near-monochrome and typographic: SF Pro, a tight
grey ink hierarchy, two corner radii plus a pill, and nothing else competing
for attention. It is scoped to `@osn/social` only — it lives in
`src/App.css` and per-screen class overrides, and never edits the shared
`@osn/ui` primitives (those are used by cire and pulse too).

## Genre

modern-minimal (utility app · left-rail workbench)

## Typography

- **Face** — SF Pro, via the system stack `-apple-system, BlinkMacSystemFont,
  "SF Pro Text", "SF Pro Display", …`. No web-font download; real SF Pro on
  Apple devices, graceful fallback elsewhere. (Apple's own optical split —
  SF Pro Text ≤19px, SF Pro Display ≥20px — happens automatically.)
- **Weights** — 400 (regular) and 500 (medium) only. No semibold/bold.
- **Tracking** — `-0.15px` everywhere (set on `body`, baked into each type token).
- **Scale — four sizes only.** Use the semantic utilities, never raw `text-lg`,
  `text-xl`, `text-base`, or arbitrary `text-[Npx]`.

  | Utility | Size / line-height | Role |
  | --- | --- | --- |
  | `text-display` | 24 / 30 | page titles (`h1`), large avatar initials |
  | `text-title`   | 14 / 20 | person & org names, section headers, card titles |
  | `text-body`    | 13 / 18 | nav, tabs, buttons, body copy, inputs, subtitles |
  | `text-meta`    | 12 / 16 | handles, timestamps, captions, badges, helper text |

## Ink hierarchy (near-monochrome)

Three greys carry all hierarchy. The only chromatic colour is the destructive red.

- `text-foreground` — `#292929` · primary text, filled-CTA background
- `text-muted-foreground` — `#5D5D5D` · secondary text (subtitles, descriptions)
- `text-subtle` — `#9E9E9E` · tertiary text + resting nav/content icons
- `--background` `#FFFFFF` · `--border` `#ECECEC` hairline · `--muted` `#F4F4F4`
  hover/fill surface · `--ring` `#5D5D5D` focus (≥3:1 on paper)
- `--destructive` unchanged (red) — remove / delete only

## Radii — two families + pill

- **8px** (`--radius`, `rounded-lg`/`rounded-md`) — nav items, list rows,
  inputs, dropdown triggers, small controls
- **16px** (`rounded-card`) — card surfaces, bordered rows, dialogs, empty states
- **pill** (`rounded-pill`) — CTA buttons (filled `default`/`secondary`/
  `destructive`) and badges. Ghost/link text buttons stay flat.

## Icons

- **14px** (`h-3.5 w-3.5`) — sidebar navigation icons
- **20px** (`h-5 w-5`) — card / content icons (row chevrons, etc.)
- Inline SVG, `stroke="currentColor"`; resting icons inherit `text-subtle`.

## Theme (light / dark)

Follow the system theme by default; the fallback is **dark**. Light is shown
only when the OS explicitly asks for light, or the user opts into light.
`prefers-color-scheme: dark` and "no preference" both resolve to dark.

- Preference (`system` / `light` / `dark`) persists in `localStorage` (`osn-theme`);
  default is `system`. Resolution lives in `src/lib/theme.ts` (`resolveTheme`).
- A synchronous mirror in `index.html` sets `.dark` before first paint (no flash).
  Keep the two in sync.
- The three-grey ink hierarchy inverts in `.dark` (paper `#1C1C1C`, ink `#F2F2F2`,
  etc.) in `App.css`; type/radii/spacing are theme-agnostic.
- Opt-in control: the `ThemeToggle` (System / Light / Dark) in the sidebar header.

## Layout

- App shell = fixed **240px left rail** (`Sidebar.tsx`) + scrollable content.
- Content column centered at `max-w-2xl`, `px-8 py-8`.
- Page head = `text-display` title + optional `text-body` muted subtitle.

## Motion

Colour/opacity transitions only (`transition-colors`). No spatial motion added.
Focus rings appear instantly, never animated.

## What screens MUST share

The SF Pro stack, the `-0.15px` tracking, the three-grey ink hierarchy, the
four-size scale, the two-radius + pill system, and the pill CTA voice.

## Implementation notes

- Tokens + base rules live in `src/App.css` (app-scoped). `@osn/ui` primitives
  use the `base:` (zero-specificity) variant, so any class passed at an
  `@osn/social` call site overrides the shared default without touching the lib.
- Cards (`@osn/ui` `Card` is `rounded-xl` by default) get `rounded-card` at the
  call site; CTA buttons get `rounded-pill`; dialogs get `rounded-card`.
