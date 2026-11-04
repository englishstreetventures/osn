# Cire soft shapes Implementation Plan

> **For agentic workers:** each phase below is one branch and one draft pull request in a stack. The orchestrator dispatches one phase per subagent; work only on your phase. Inside a phase, run `superpowers:subagent-driven-development` or work the tasks in order. Steps use checkbox (`- [ ]`) syntax.

**Goal:** cire's buttons become pills with sentence-case labels, fields and tiles take 14px corners, cards 16px, and every cire surface uses the shared parts and one radius vocabulary.

**Architecture:** a new `field` role in the shared radius contract separates inputs from buttons; `@cire/ui` Button and Card take their corners from contract roles; each cire app maps the roles and a softened size scale once in its stylesheet; a sweep moves hand-written styling onto roles and shared parts and rewrites labels to sentence case.

**Tech Stack:** Tailwind v4 `@theme`, SolidJS, Vitest (unit and browser projects), the component lab (`tools/lab`), Astro (invites, landing), the E2E suite (`tools/e2e`).

**Spec:** `docs/superpowers/specs/2026-10-28-cire-soft-shapes-design.md` (owner-approved 2026-10-28). Issue: englishstreetventures/osn#1821. Owner decisions: https://github.com/englishstreetventures/osn/issues/1821#issuecomment-6466206517 and #issuecomment-6466490383, plus the label-copy answer posted with this plan. Plan attack: `docs/superpowers/plans/2026-10-28-cire-soft-shapes-review.md`.

## Global Constraints

- cire values: `control` 999px (pill) · `field` 14px · `lg` 16px · `md` 10px · `sm` 6px · `hair` 2px · `pill` 999px. `sheet` stays 1.75rem in invites and landing. `--toast-radius` is `md` (10px) in all four cire apps.
- What each step paints in cire after Phase 4: buttons pill; inputs, selects, textareas, `tile`, `field`, size `swatch` 14px; cards and centred modals 16px; popovers, dropdown menus, tooltips, toasts 10px; checkboxes, notices, empty states, table highlights, small badges 6px; focus marks and colour swatch dots 2px.
- musubi and pulse render unchanged by every phase.
- Colour tokens are not touched in any package.
- Button and link labels: true sentence case in the source text ("Event details", "Enter your code"), no `uppercase`, normal tracking, `font-medium` on boxed sizes. Eyebrows, table heads, badges and small-caps tab strips stay uppercase. (Owner, 2026-10-28: rewrite labels.)
- Every token read in `@theme inline` uses the `var(--ui-x, <fallback>)` form (`shared/design-tokens/src/tokens.css:31-53`).
- Motion uses `--dur-*` and `--ease-*` tokens only; no animation library.
- Tests live in `tests/` mirroring `src/`. Test commands per package: `cire/host` `test:run` (unit) and `test:browser`; `cire/invites` `test` (unit + ssr) and `test:browser`; `cire/vendor`, `cire/landing`, `cire/ui`, `shared/design-tokens`, `tools/lab` `test:run`; `shared/ui` and `musubi/social` `test:run` and `test:browser`.
- Changesets named by exact workspace `name`; versioned (`@shared/*`, `@tools/lab`) never share a changeset with version-less `@cire/*`. Any phase that edits `tools/lab` adds an `@tools/lab` changeset and runs `bun run --cwd tools/lab test:run`.
- Installs: `bun install --frozen-lockfile`; add a dependency with `bun add <pkg> --cwd <dir>`.

## Review Focus

1. A caller's plain `class="rounded-…"` on `<Button>` must still beat the variant corner (`cire/ui/src/button.tsx:29-36`) — Phase 2 test, red on main through `chip`.
2. A subtree that scopes only `--ui-radius-control` still reaches `field` — Phase 1 test.
3. Inputs in cire never render as pills — Phase 4 host browser test: computed `border-radius` of an input on the RSVP page is `14px`.
4. A boxed `icon` button is a 32px circle — Phase 2 lab screenshot (happy-dom computes no layout, so no automated check).
5. The four cire stylesheets' radius scales drift apart later — Phase 4 tokens test.

---

## Phase 1 — `feat/cire-soft-shapes-field-radius` (`@shared/design-tokens`, `@shared/ui`, `@tools/lab`)

### Task 1.1: `field` radius role

**Files:**
- Modify: `shared/design-tokens/src/tokens.css:137-164` (add `--radius-ui-field` beside `--radius-ui-control`, with a comment saying it is the text-input role and defaults to `control`; rewrite `:143-149`'s "cire's is a sharp 4px" to state cire's role values)
- Modify: `shared/design-tokens/src/index.ts:51-66` (add `"--ui-radius-field"` after `"--ui-radius-control"`, with a comment; rewrite `:57-61`'s cire sentence)
- Modify: `shared/ui/src/ui/control.ts:39` (`base:rounded-ui-control` → `base:rounded-ui-field`)
- Modify: `tools/lab/src/stories/design-system/utilities.ts` (`ROUNDED` gains `field`)
- Modify: `tools/lab/src/stories/design-system/theming.story.tsx:83-94` (`CIRE_RADIUS` gains `--ui-radius-field`; values become the Global Constraints numbers)
- Modify: `tools/lab/src/stories/design-system/shape.story.tsx:43,78-79` (cire wording; the Input reads `rounded-ui-field`)
- Test: `shared/design-tokens/tests/tokens-css-agrees.test.ts`, `musubi/social/tests/styles/token-contract.browser.test.tsx`

**Interfaces:**
- Produces: utility `rounded-ui-field`; input `--ui-radius-field`; `--radius-ui-field: var(--ui-radius-field, var(--ui-radius-control, var(--ui-radius-md, 6px)))`.

- [ ] **Step 1:** Add test `field falls back through control, not past it` to `tokens-css-agrees.test.ts`: the `--radius-ui-field` declaration in `tokens.css` equals the Produces value. Add to `token-contract.browser.test.tsx` (beside the radius read at `:145-157`) an assertion that a rendered `Input`'s computed `border-top-left-radius` equals the computed value of `--ui-radius-control`. Run `bun run --cwd shared/design-tokens test:run` → FAIL (no declaration).
- [ ] **Step 2:** Implement the Files list. Run: `bun run --cwd shared/design-tokens test:run`, `bun run --cwd shared/ui test:run`, `bun run --cwd shared/ui test:browser`, `bun run --cwd musubi/social test:browser`, `bun run --cwd tools/lab test:run`, `bun run check` → all PASS.
- [ ] **Step 3:** Lab evidence: screenshots of shared-ui `forms` and `button` and `design-system/theming` before (origin/main) and after, plus pulse's sign-in form (`bun run dev:pulse`), to `e2e-artifacts/cire-soft-shapes/phase1/`. Musubi and pulse panels must match.
- [ ] **Step 4:** Changesets: `@shared/design-tokens` + `@shared/ui` (patch), `@tools/lab` (patch). Wiki with `write-wiki`: `wiki/shared/design-tokens.md:104-124` (radius roles prose gains `field`, cire values corrected), `wiki/shared/osn-and-musubi.md:74`. Commit.

### Task 1.2: lab can import `@cire/ui`

**Files:** `tools/lab/package.json` (via `bun add @cire/ui@workspace:* --cwd tools/lab`), `bun.lock`.

- [ ] Add the dependency (`wiki/conventions/stacked-prs.md:199`: the bottom PR adds every package the stack's stories import). The lockfile diff is that one entry only. `bun run --cwd tools/lab test:run` PASS. Commit with Task 1.1's `@tools/lab` changeset.

---

## Phase 2 — `feat/cire-soft-shapes-button` (`@cire/ui` Button), on Phase 1

### Task 2.1: corner per variant and size; sentence case

**Files:**
- Modify: `cire/ui/src/button.tsx` (`BASE` loses its corner; new `CORNER` choice in `buttonClass`; `VARIANT.chip` loses `rounded-full`; `SIZE`, `TILE_SIZE` lose `uppercase` and `tracking-ui-wider`, including `icon` at `:279`, `:315`; module doc's "sharp 4px corner" and "uppercase, tracked" sentences rewritten)
- Test: `cire/ui/tests/ui.test.tsx` (`:95-105` "does not shout…" is rewritten as the sentence-case test)
- Create: `tools/lab/src/stories/cire-ui/button.story.tsx`

**Interfaces:**
- Consumes: `rounded-ui-field` (Phase 1); `@cire/ui` importable from the lab (Task 1.2).
- Produces: unchanged exports `Button`, `buttonClass({ variant, size })`, `ButtonVariant`, `ButtonSize`.

Corner rule — exactly one corner class per class string, always `base:`-prefixed:

| | corner |
|---|---|
| size `swatch`, any variant | `base:rounded-ui-field` |
| variant `tile` or `field` | `base:rounded-ui-field` |
| every other variant and size | `base:rounded-ui-control` |

So the palette presets (`PaletteField.tsx:124-130`, `choice` default size) and the Desktop/Phone toggle (`invite/previews.tsx:63`, `choice` `sm`) become pills; only `RegistryImageField.tsx:534` (`swatch`) is a soft square.

- [ ] **Step 1: failing tests** in `cire/ui/tests/ui.test.tsx`:
  - `every action variant is a pill`: for `primary, cta, outline, quiet, quietDanger, danger, choice, dashed, chip`, `buttonClass({variant})` contains `base:rounded-ui-control` and exactly one `rounded-` token.
  - `tile, field and swatch take the field corner`: `tile`, `field`, and `choice`+`swatch` contain `base:rounded-ui-field` and not `rounded-ui-control`.
  - `labels are sentence case`: sizes `sm, md, lg, icon` on `primary` and `tile` contain neither `uppercase` nor `tracking-ui-wider`; boxed `sm, md, lg` contain `base:font-medium`.
  - `a caller's corner still wins`: `<Button variant="chip" class="rounded-none">x</Button>`; every `rounded-` token in the class except `rounded-none` is `base:`-prefixed. (Red on main: `button.tsx:203`.)
  Run `bun run --cwd cire/ui test:run` → FAIL.
- [ ] **Step 2:** Implement. Side padding: `sm` `px-4`, `md` `px-5`, `lg` `px-7`; vertical unchanged. `test:run` PASS; `bun run --cwd cire/ui test:mutation --changed` (class-string survivors accepted per `cire/ui/tests/ui.test.tsx:13-17`; list them in the PR).
- [ ] **Step 3:** Lab story, one panel per variant at each size, light and dark, wrapped in cire's `--ui-*` colours and the Global Constraints radii as `theming.story.tsx:83-94` does (`wiki/conventions/component-lab.md` §Stories for auth and cire components). `bun run --cwd tools/lab test:run` PASS (imports every story).
- [ ] **Step 4:** Render at phone and desktop width, light and dark; screenshots to `e2e-artifacts/cire-soft-shapes/phase2/`, including the boxed `icon` button (32px circle). Run `web-design-guidelines` against it.
- [ ] **Step 5:** `bun run --cwd cire/host test:run` and `test:browser`, `bun run --cwd cire/invites test` and `test:browser` still pass (they render Button). Changesets: `@cire/ui` (version-less) and `@tools/lab` (separate). Commit.

---

## Phase 3 — `feat/cire-soft-shapes-card` (`@cire/ui` Card), on Phase 2

### Task 3.1: 16px card

**Files:** `cire/ui/src/card.tsx:22` (`base:rounded-ui-sm` → `base:rounded-ui-lg`); `cire/ui/tests/ui.test.tsx` (Card block); create `tools/lab/src/stories/cire-ui/card.story.tsx`.

- [ ] **Step 1:** Failing test `a card takes the large corner`: `cardClass()` contains `base:rounded-ui-lg` and exactly one `rounded-` token. FAIL.
- [ ] **Step 2:** Implement; PASS; `test:mutation --changed`. (Until Phase 4 the apps map `lg` to 6px, so dev shows 6px cards between merges; harmless.)
- [ ] **Step 3:** Lab story in Phase 2's cire wrapper (plain, `interactive`, with `CardEyebrow`); `tools/lab test:run`; screenshots to `e2e-artifacts/cire-soft-shapes/phase3/`. Changesets `@cire/ui`, `@tools/lab`. Commit.

---

## Phase 4 — `feat/cire-soft-shapes` (cire apps), on Phase 3

### Task 4.1: one scale and role mapping in four stylesheets

**Files:**
- `cire/host/src/styles/global.css:319-322` (`--radius-sm: 6px`, `--radius-md: 10px`; add `--radius-field: 14px`, `--radius-card: 16px`), `:445-451` (`--ui-radius-lg: var(--radius-card)`, `--ui-radius-control: var(--radius-pill)`, add `--ui-radius-field: var(--radius-field)`), `:273` (`--toast-radius` stays `var(--radius-md)`), and the "No `lg`" comment
- `cire/vendor/src/styles/global.css:285-288`, `:396-402`, `:246` — identical
- `cire/invites/src/styles/global.css:875-885`, `:667` (`--toast-radius: var(--radius-md)`), and `cire/landing/src/styles/global.css:350-360`: declare the same `--radius-*` scale in an `@theme static` block (plain `@theme` at `invites:436`, `landing:22` drops variables no utility reads, `cire/host/src/styles/global.css:298-304`); map `--ui-radius-*` to it; keep `--ui-radius-sheet: 1.75rem`
- Test: `cire/vendor/tests/styles/tokens.test.ts` (new `describe`)

- [ ] **Step 1:** Failing test `every cire surface carries one radius scale`: read the four stylesheets; resolve each `--ui-radius-*` and `--toast-radius` through `var()` aliases to a length; assert each equals the Global Constraints number and all four agree. `--ui-radius-sheet` is exempt by name (host and vendor never use the sheet presentation). FAIL.
- [ ] **Step 2:** Edit the four stylesheets. PASS. `bun run --cwd cire/<pkg> build` for invites and landing succeeds.

### Task 4.2: sweep

Per spec §Sweep rules, one commit per package: host, vendor, invites, landing, then `cire/api`. Find sites with `git grep` at the branch head, not from counts. The class includes:

- raw `<button>` (`git grep -n "<button" -- cire/<pkg>/src`); converted buttons keep `type="submit"` wherever the raw one submits a form today (`Button` defaults `type="button"`, `button.tsx:377`);
- `rounded-*` utilities, CSS `border-radius` in `.css` and `.astro` files, inline `style` radii;
- CSS-class buttons: landing `.cta-primary` and `.cta-ghost` (`cire/landing/src/styles/global.css:162-185`, used `Hero.astro:56,63`, `FinalCta.astro:29,36`) and `.site-nav__cta` (`SiteNav.astro:73-77`) move to pill corners, sentence case, `--dur-*` transitions; `Figure.astro:43,65` radii to the scale; uppercase CSS in `PrivacyNav.astro:62-63` and both `LegalLayout.astro` files checked against the uppercase rule;
- `cire/api/src/routes/rsvp-digest-stop.ts:51` (cire-branded button, `border-radius:6px` inline) → `999px`, sentence-case label;
- label strings: every button and link label rewritten to sentence case in source; every test query and E2E flow that finds it by name updated in the same commit (`git grep -n "<old label>" -- cire tools/e2e`; "Event Details" alone is ~55 lines in 6 invites test files and `cire-rsvp.flow.ts`, `cire-event-details.flow.ts` and both after-deadline flows);
- motion: literal durations and bare `transition` to `--dur-*`. Invites and landing define no `--dur-*` today: copy the host's ladder from `cire/host/src/styles/global.css:218-232` (`--motion-scale`, the three durations and the whole `pointer: fine` block) and `--ease-*` from `:324-329`.

Stay as they are: avatars and status dots (`rounded-full`), the section tabs pinned non-pill by `GuestsMarks.browser.test.tsx:341-346` (`EditWorkspace.tsx:145`), table heads, the sort button in a table head (`RsvpView.tsx:639-643`).

Tests:
- [ ] Update class-pinned tests to the new value with the same intent: `cire/host/tests/components/invite/previews.test.tsx:360`, `cire/invites/tests/components/EventCard.test.tsx:460`, `cire/invites/tests/components/InviteClosing.test.tsx:170`. Rewrite the absence-by-selector checks so they cannot pass vacuously after a rename — assert the positive thing instead: `cire/host/tests/components/InviteBuilder.test.tsx:1665,1677,1693`, `cire/invites/tests/components/LoginSection.test.tsx:892`.
- [ ] New host browser test (Review Focus 3) `tests/components/soft-shapes.browser.test.tsx`: on the RSVP view, an input's computed `border-top-left-radius` is `14px`, and a primary Button's is at least half its height.
- [ ] New vendor test for the dashboard screenshots (vendor is not in the E2E stack, `tools/e2e/src/stack.ts:33,182-185`): `cire/vendor/tests/components/soft-shapes.browser.test.tsx` renders the dashboard in light and dark, phone and desktop, and writes screenshots to `e2e-artifacts/cire-soft-shapes/vendor/`. If vendor has no browser project, add one copying `cire/host/vitest.config.ts:51-80`.
- [ ] Run per package: host `test:run` + `test:browser`; invites `test` + `test:browser`; vendor and landing `test:run`; `cire/api` `test:run`. Then `test:mutation --changed` once per package at the end (class-string survivors accepted as in Phase 2, listed in the PR).

### Task 4.3: DESIGN.md and wiki

- [ ] `cire/host/DESIGN.md` §4 "Shape, depth, motion" (`:176-182`): the radius roles and values from Global Constraints, the reason (owner, 2026-10-28: smoother, less rigid), the small-mark rule. §7 Components (#1625): parts come from `@shared/ui` and `@cire/ui`; the `Button` row names the sixteen variants by group and the corner rule; drop `src/components/ui/` and `ui.test.tsx`; button-label language becomes sentence case.
- [ ] `cire/vendor/DESIGN.md` §Components: drop `src/components/ui/`; `Chip` is `shared/ui/src/ui/chip.tsx`, `Loading` is `cire/ui/src/loading.tsx`, find `Checkbox` with `git grep -n "Checkbox" -- cire/vendor/src shared/ui/src`; add that radii are asserted equal across the four cire apps.
- [ ] Wiki with `write-wiki`: `wiki/shared/component-library.md` (cire Button line `:47` and any shape claim), `wiki/cire/cire-invite-designs.md` and `wiki/cire/cire-landing.md` if they state corners or case, `wiki/cire/cire-host-portal-layout.md` if it states button case.
- [ ] Every path, variant count and radius value in both `DESIGN.md` files checked by `ls` or `git grep`.

### Task 4.4: proof

- [ ] New flow `tools/e2e/tests/flows/cire-soft-shapes.flow.ts`: host guest list, RSVP table, and the invite RSVP sheet and each invitation design, light and dark, phone and desktop; screenshots into `e2e-artifacts/`. `bun run test:e2e` PASS, including the flows whose label queries changed.
- [ ] Changeset: `@cire/host`, `@cire/vendor`, `@cire/invites`, `@cire/landing`, `@cire/api` (version-less, one changeset); `@tools/e2e` separately if versioned (`jq .version tools/e2e/package.json`).
- [ ] PR body `Closes #1821` and `Closes #1625`.
