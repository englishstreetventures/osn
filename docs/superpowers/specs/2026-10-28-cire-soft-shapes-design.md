# Cire soft shapes — design

Issue: englishstreetventures/osn#1821 (folds #1625). Owner decisions: https://github.com/englishstreetventures/osn/issues/1821#issuecomment-6466206517

## Intent

Cire is a wedding product. Its controls today are 4px rectangles with uppercase, letter-spaced labels — a stationery look the owner finds too rigid. The owner wants cire to feel smooth and relaxed: rounder controls, softer labels, and one consistent look across the host portal, vendor portal, guest site and marketing site. The recent guests, RSVP and motion pull requests (#1814, #1815, #1818, #1807) were each written against the old rules, so the sweep also brings their hand-written styling onto the shared parts.

## Decided by the owner

- **Actions are pills.** Every boxed `@cire/ui` `Button` variant that is an action (`primary`, `cta`, `outline`, `quiet`, `quietDanger`, `danger`, `choice`, `dashed`, `chip`) has fully round ends.
- **Tiles and fields: 14px corners.** The `tile` and `field` Button variants, and text inputs, selects and textareas.
- **Cards: 16px corners.** `@cire/ui` `Card` and surfaces drawn as cards.
- **Sentence-case labels** at normal letter-spacing on buttons. Eyebrows, table heads and other small-caps labels stay uppercase.
- **Colours stay per app.** Host and vendor keep separate colour tokens; this work changes shape, label case and motion only.
- References: Partiful's pill Save and "+ New option" buttons, Givingli's dark pill call to action. Luma's 8px rectangle was the rejected alternative.

## Goals

1. One radius vocabulary for cire, named by role, defined once per app stylesheet.
2. `@cire/ui` `Button` and `Card` take their corners from those roles.
3. Every cire surface uses the shared parts and roles instead of hand-written corners and raw buttons where a shared part fits.
4. `cire/host/DESIGN.md` and `cire/vendor/DESIGN.md` describe the code as it is after this work.

## Non-goals

- No colour, font or palette change.
- No change to how musubi or pulse look. Shared-package changes must render those apps pixel-identical.
- No change to couples' invitation designs' typography, ornament or colour. Their frames do soften: they render in `cire/invites/src/designs/*/` (for example `classic/InviteHeader.tsx:385,397`, `gala/InviteHeader.tsx:405,418`) and in the host's preview (`cire/host/src/components/invite/previews.tsx:245`) on `rounded-sm`, and take the new 6px step with everything else (owner, 2026-10-28).
- No new animation library; motion stays on the existing `--dur-*` and `--ease-*` tokens.

## Anti-goals

- Pill-shaped text inputs. The owner chose 14px for fields; a pill input reads as a search box.
- Rounding everything to the same radius. Small marks stay small-cornered: colour swatch dots and focus marks at 2px; checkboxes, notices and table highlights at 6px; tooltips, popovers and menus at 10px. A 14px checkbox looks like a mistake.
- A shared-package change that shifts musubi's or pulse's look.

## The how (builder's calls, marked as mine)

### Radius roles

The shared contract (`shared/design-tokens/src/tokens.css:137-164`) has size steps (`hair`, `sm`, `md`, `lg`, `pill`) and two roles: `control` ("how round a button is"; musubi maps it to pill) and `sheet`. `shared/ui/src/ui/control.ts:39` paints `Input`, `Textarea` and `Select` with `control` as well, so mapping cire's `control` to a pill would make every text field a pill.

*My call:* add a third role, `field`, to `@shared/design-tokens`:

```css
--radius-ui-field: var(--ui-radius-field, var(--ui-radius-control, var(--ui-radius-md, 6px)));
```

Every read in `@theme inline` takes the `var(--ui-x, <fallback>)` form (`tokens.css:31-53`), so a subtree that scopes only `--ui-radius-control` still reaches `field`. The name joins the token list in `shared/design-tokens/src/index.ts:51-66`. It defaults to `control`, so musubi and pulse render exactly as now. `control.ts` switches to `rounded-ui-field`. Cire's apps then map:

| Role | cire value | Paints |
|---|---|---|
| `control` | pill (999px) | action buttons |
| `field` | 14px | inputs, selects, textareas, `tile`, `field` |
| `lg` | 16px | cards, modals (shared `Modal` centred uses `rounded-ui-lg`) |
| `md` | 10px | popovers, menus, tooltips, toasts (`--toast-radius` in all four apps) |
| `sm` | 6px | checkboxes, notices, empty states, badges with text that are not pills, small panels, table highlights |
| `hair` | 2px | colour swatch dots, focus marks |

*My call:* raise `sm` from 4px to 6px and `md` from 6px to 10px in the host and vendor scales (`cire/host/src/styles/global.css:319-322`, `cire/vendor/src/styles/global.css:285-288`). Host writes `rounded-sm` 153 times; nudging the scale softens all of those at once, and the sweep then moves only the sites whose role is clearly a field, card or button. Invites and landing have no scale of their own today (Tailwind defaults; `cire/invites/src/styles/global.css:875-885` and `cire/landing/src/styles/global.css:350-360` map `--ui-radius-*` as literals); they get the same scale and role mapping, so all four surfaces share one set of numbers. `cire/vendor/tests/styles/tokens.test.ts` compares only the colour ramps today (`:166-186`); it gains an assertion that the `--radius-*` scale and `--ui-radius-*` mapping are identical across all four cire stylesheets.

### Label case

Owner, 2026-10-28: labels are rewritten to true sentence case in the source text ("Event details", "Enter your code"), not only restyled; tests and E2E flows that find a control by name change with it.

*My call:* the boxed sizes in `cire/ui/src/button.tsx` (`SIZE`, `TILE_SIZE`) drop `uppercase` and `tracking-ui-wider` and take `font-medium`. A `tile`'s interior is composed content and loses the uppercase too. The `icon` size drops the `base:uppercase` it carries today (`button.tsx:279`, `:315`); a glyph has no case.

### Button details

- The corner leaves `BASE` and is chosen once per variant and size, so exactly one `base:` corner class is emitted and the caller's plain `class` still wins (`button.tsx:29-36`). Action variants take `base:rounded-ui-control`; `tile` and `field` take `base:rounded-ui-field`; the `swatch` size takes `base:rounded-ui-field` whatever the variant, so a framed thumbnail is a soft square, not a lozenge (`RegistryImageField.tsx:534`, the only `swatch` caller). Palette presets (`PaletteField.tsx:124-130`) and the Desktop/Phone toggle (`invite/previews.tsx:63`) are `choice` at ordinary sizes and become pills. Boxed `icon` buttons become circles (32px square with a pill corner) — my call, matching Partiful's round icon buttons.
- `chip`'s plain `rounded-full` becomes `base:rounded-ui-pill`: it sits beside a round close button and stays round whatever an app maps `control` to, including the 4px cire maps until the last pull request of the stack (decided in Phase 2, when the invites sheet test showed square chips).
- Pill buttons need more side padding than a rectangle to look balanced: `md` moves from `px-4` to `px-5`, `lg` from `px-6` to `px-7`, `sm` from `px-3` to `px-4`. Heights stay the same, so no layout moves vertically.

### Sweep rules

For each hand-written corner or raw `<button>` in `cire/host/src`, `cire/vendor/src`, `cire/invites/src`, `cire/landing/src`:

1. A raw `<button>` whose classes match a Button variant becomes that `Button` (or `buttonClass` on an `<a>`). One that does something no variant does (a calendar day cell, a crop handle, a sortable grip) stays raw and says why in a comment if it does not already.
2. A corner on something that is a field, card, tile or button moves to the role utility (`rounded-ui-field`, `rounded-ui-lg`, `rounded-ui-control`) or the shared part.
3. Uppercase, tracked labels on buttons and links move to sentence case. Eyebrows, table heads, tab strips that are small-caps by design, and badges stay.
4. Motion written as a literal duration or Tailwind's bare `transition` (150ms) moves to a `--dur-*` token. Invites and landing: first check whether they define `--dur-*`; if not, they get the host's ladder.
5. Keep each changed test's intent: a test that pinned `rounded-sm` or `uppercase` is updated to the new value, not deleted, unless the thing it guarded no longer exists.

### Stack

Frontend stack per `wiki/conventions/stacked-prs.md` §Frontend, bottom up:

1. `feat/cire-soft-shapes-field-radius` — `@shared/design-tokens` `field` role + `@shared/ui` `control.ts`. Lab: existing `design-system/shape.story.tsx` shows the new role.
2. `feat/cire-soft-shapes-button` — `@cire/ui` `Button`. New lab stories under `tools/lab/src/stories/cire-ui/`.
3. `feat/cire-soft-shapes-card` — `@cire/ui` `Card`. Lab story.
4. `feat/cire-soft-shapes` — app scales and role mapping in all four stylesheets, the sweep, DESIGN.md rewrites, wiki pages, E2E screenshots.

All four open as drafts; the owner marks the top one ready.

## Left to the builder

- Which raw buttons fit a variant and which stay raw, site by site.
- Whether any small mark currently at `rounded-sm` needs `rounded-hair` after `sm` rises to 6px.
- Exact padding if the lab render shows the pills unbalanced.

## Done when

The issue's Done when, with its grep reading: every remaining `rounded-sm` or `rounded-md` is the named 6px or 10px step in `DESIGN.md`, and none paints a field, card or button. Plus:
- After step 1, before-and-after screenshots of the lab's musubi-mapped Button and Input stories, and of pulse's own app (the lab has no pulse mapping, `tools/lab/src/lab.css:7`), show no change. No screenshot-diff harness is built.
- `@cire/ui` lab stories wrap the component in cire's `--ui-*` mapping, as `tools/lab/src/stories/design-system/theming.story.tsx:83-93` does, with cire's new radii.
- The tokens test asserts the four cire stylesheets carry the same radius numbers.
