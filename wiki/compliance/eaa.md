---
title: European Accessibility Act (EAA)
tags: [compliance, eaa, accessibility, wcag]
related:
  - "[[index]]"
  - "[[scope-matrix]]"
  - "[[component-library]]"
last-reviewed: 2026-04-26
---

# EAA — Accessibility

Effective 28 June 2025. The EAA brings consumer-facing apps and services
in the EU under WCAG 2.1 AA. OSN's frontend surfaces — `@pulse/app`,
`@osn/social`, `@zap/app` (when shipped), and `@osn/landing` — all qualify
as "consumer-oriented services" once we have EU users.

## What WCAG 2.1 AA requires (the highlights)

| Principle | Examples that bite us |
|---|---|
| Perceivable | Alt text on event cover images; captions on Zap voice notes (M5); colour contrast ≥4.5:1 in Pulse design tokens; Pulse calendar must have a non-colour way to distinguish event states. |
| Operable | Every interactive control reachable by keyboard; focus visible; Pulse map controls have keyboard equivalents; no auto-playing media >5 s without pause. |
| Understandable | Form labels not just placeholders; error messages identify the field + the fix; Zap message-send button announces "Sending" + "Sent" to screen readers. |
| Robust | Valid HTML; ARIA only as fallback; works in screen readers (VoiceOver, NVDA, TalkBack). |

## OSN status

| Surface | Today | Gap |
|---|---|---|
| `@osn/landing` | Astro static site, simple markup | Run `axe-core` audit; document. |
| `@osn/social` | Solid + Kobalte; Kobalte primitives are accessible by default | Custom components (ProfileSwitcher, SecurityEventsBanner) need an audit. |
| `@pulse/app` | Solid + Kobalte; map + calendar are custom | The map's keyboard story is unproven; audit. |
| `@zap/app` | Not shipped | Build accessibility into the Tauri spec. |

## Project changes required

Tracked with `C-` IDs:

1. **Axe-core in CI** — `@axe-core/playwright` running against `@osn/landing`, `@osn/social`, `@pulse/app` on every PR. Fail on serious / critical violations. ID: **C-M14**. Locked design constraints:
   - **Per-app route allowlist** kept in each app's repo as `tests/a11y/routes.ts`. Initial set: landing `/`, `/legal/*`; social `/`, `/login`, `/account`, `/sessions`; pulse `/`, `/event/[id]`, `/explore`. Adding a new top-level route is the trigger to add it to the allowlist (enforced via a lint rule comparing top-level pages to the allowlist file).
   - **Browser pinned** via `playwright install chromium --with-deps` cached by the Playwright version hash so CI cold-start stays under a minute.
   - **Run-time budget** ≤90 s for the full PR suite, parallelised across the three apps via `playwright --workers`.
   - **Severity gating** — PR job fails on `serious` + `critical` only; full WCAG 2.1 AA audit (incl. `moderate` + `minor`) runs nightly so PR latency stays low while drift is still caught.
2. **Solid-aware a11y lint coverage** — `oxlintrc.json` already enables `jsx-a11y`; verify the rule set matches WCAG 2.1 AA (some rules may be off by default). ID: **C-L12**.
3. **Manual screen-reader test** — pre-release checklist: VoiceOver on macOS Safari, NVDA on Windows Firefox, TalkBack on Android Chrome (when Android lands). ID: **C-L13**.
4. **Pulse map keyboard parity** — ensure marker selection, zoom, pan, and detail expand all reachable by keyboard. ID: **C-L14**.
5. **Pulse calendar non-colour state cues** — icons / text labels distinguish "Not Started / Started / Ongoing / Finished" beyond colour. ID: **C-L15**.
6. **Accessibility statement** on `@osn/landing/legal/accessibility` listing supported AT, known gaps, contact. EAA Art. 13 requires this. ID: **C-L16**.
7. **Captions for any video content** on `@osn/landing`. EAA Art. 4. ID: **C-L17**.

## Tauri-specific risks

Tauri webviews on iOS / Android inherit the platform AT story. Two
specifics worth flagging early:

- **VoiceOver focus traps** — Solid's reactive DOM updates can confuse
  focus order if we manipulate it imperatively. Stick to
  declarative `<For>` / `<Show>` and let Kobalte handle focus
  management.
- **Dynamic Type / large fonts** — iOS users routinely set 200% font
  size. Verify Pulse + Zap do not break layout under that condition.

## See also

- WCAG 2.1: https://www.w3.org/TR/WCAG21/
- EAA text: Directive (EU) 2019/882
- Kobalte accessibility docs: https://kobalte.dev/
