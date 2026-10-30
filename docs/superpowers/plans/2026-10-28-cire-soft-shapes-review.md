# PLAN-REVIEW — cire soft shapes (#1821)

Attacker run 2026-10-28 on origin/main c9459aa57. 17 findings: 15 fixed in the plan, 1 rejected, 1 escalated and answered.

| # | Sev | Finding | Outcome |
|---|---|---|---|
| 1 | H | `tools/lab` has no `@cire/ui` dependency (`tools/lab/package.json:26-34`); `stacked-prs.md:199` puts it on the bottom PR with an `@tools/lab` changeset | Fixed: Phase 1 Task 1.2 adds it; every phase touching `tools/lab` adds an `@tools/lab` changeset and runs its `test:run` |
| 2 | H | `test:run` skips browser tests (host, shared/ui); invites has no `test:run` | Fixed: each phase names `test:browser`, and invites uses `test` |
| 3 | H | E2E stack has no vendor portal (`tools/e2e/src/stack.ts:33,182-185`); no flow takes the screenshots | Fixed: new flow `tools/e2e/tests/flows/cire-soft-shapes.flow.ts` for host and invites; vendor screenshots come from a vendor browser test |
| 4 | M | `index.ts` entry alone fails no test; `theming.story.tsx:84-94` `satisfies Record<RadiusToken,…>` breaks the type check | Fixed: Step 1 rewritten; `theming.story.tsx` and `shape.story.tsx:78-79` in the file list |
| 5 | M | Sweep misses landing `.cta-primary`/`.cta-ghost` (`global.css:162-185`), `.site-nav__cta`, CSS uppercase in `PrivacyNav.astro`, `LegalLayout.astro`, `Figure.astro` radius, invites `--toast-radius: 0.25rem` (`:667`), `cire/api/src/routes/rsvp-digest-stop.ts:51` | Fixed: sweep rules gain a CSS pass and these named sites |
| 6 | M | Sentence case: CSS only, or rewrite strings? | Escalated → owner 2026-10-28: rewrite labels to true sentence case; update name-based test queries and E2E flows |
| 7 | M | Scale change reaches Tooltip, Checkbox, Notice, EmptyState, Table, Popover, DropdownMenu, toasts; conflicts with spec anti-goal on tooltip and checkbox | Fixed: spec table amended (tooltip/popover/menu 10px, checkbox and table highlight 6px — builder's call, anti-goal narrowed to swatches and focus marks); toasts join the radius test |
| 8 | M | Palette presets (`PaletteField.tsx:124-130`) are `choice` default size; `previews.tsx:63` is a size-`sm` toggle; only `RegistryImageField.tsx:534` is `swatch` | Fixed: spec and plan say presets and the toggle become pills; only `swatch` takes the field corner |
| 9 | M | `--dur-*` copy range omits `--motion-scale` (`:218`) and the `pointer: fine` block end (`:229-232`) | Fixed: range is `:218-232` |
| 10 | M | Radius test must resolve `var()` aliases; `sheet` only in invites/landing; plain `@theme` drops unread vars | Fixed: test resolves aliases, exempts `sheet` by name, invites/landing declare the scale in `@theme static` |
| 11 | L/M | Caller-wins test is green on main; class strings can't prove cascade; 32px circle needs a screenshot | Fixed: test uses `variant="chip"` (red today, `button.tsx:203`); circle checked by screenshot only, stated |
| 12 | L | Mutation run cost and class-string survivors | Fixed: `test:mutation --changed` run per package once at the end of Phase 4; surviving class-string mutants recorded as accepted per `cire/ui/tests/ui.test.tsx:13-17` |
| 13 | L | Vacuous absence selectors (`InviteBuilder.test.tsx:1665,1677,1693` in host; `LoginSection.test.tsx:892`); `GuestsMarks.browser.test.tsx:341-346` pins tabs non-pill; Phase 2 Step 5 targets are not Buttons | Fixed: absence checks rewritten to positive ones; `EditWorkspace.tsx:145` tabs stay; Phase 2 Step 5 removed (those are a table head and a status word) |
| 14 | L | Stale "sharp 4px" claims in `tokens.css:143-149`, `index.ts:57-61`, `shape.story.tsx:43`, `theming.story.tsx:83-94`, `wiki/shared/osn-and-musubi.md:74`, `wiki/shared/design-tokens.md:104-124`, four stylesheets' "No `lg`" comments; DESIGN.md §4 is "Shape, depth, motion" | Fixed: listed in the phase that changes each |
| 15 | L | Vendor component grep scoped wrongly | Fixed: Chip is `shared/ui/src/ui/chip.tsx`, Loading `cire/ui/src/loading.tsx` |
| 16 | L | `web-design-guidelines` "not in the repo" | **Rejected:** it is a user-level skill, listed in this session's skills, and `.claude/skills/design-system/SKILL.md` Step 3 names it as one ("the rest are user-level skills on the maintainer's machine") |
| 17 | L | Raw untyped `<button>` in a form submits; `Button` defaults `type="button"` (`button.tsx:377`) | Fixed: sweep rule 1 keeps `type="submit"` on any converted button that submits today |

Cost avoided: musubi "unchanged" proved by one assertion in `musubi/social/tests/styles/token-contract.browser.test.tsx` (computed Input radius) instead of screenshots alone.

Findings by origin: plan 16, brief 0, worker 0.
