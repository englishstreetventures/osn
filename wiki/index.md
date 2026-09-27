---
title: OSN Wiki
aliases: [home, map of content, MOC]
tags: [index]
related:
  - "[[deferred-decisions]]"
  - "[[decisions/README]]"
  - "[[osn-and-musubi]]"
  - "[[monorepo-structure]]"
  - "[[compliance/index]]"
last-reviewed: 2026-09-27
---

# OSN Wiki

Map of content for the OSN monorepo. The folders mirror the monorepo: one per product, `shared/` for what applies to all of them, and `conventions/`, `decisions/` and `compliance/` for how we work, what we chose and what the law needs. Open the vault in Obsidian for graph view and backlinks.

- [`../AGENTS.md`](../AGENTS.md) — the agent entry point at the repo root (outside the vault)

## Shared

Applies to every product: architecture, platform systems, observability, deploys.

- [[osn-and-musubi]] — OSN the system vs Musubi our implementation; the rule that decides which name anything takes
- [[monorepo-structure]] — workspace layout, domain prefixes, directory tree
- [[backend-patterns]] — Elysia route factories, Effect pipelines, service layer
- [[schema-layers]] — Elysia TypeBox (HTTP) vs Effect Schema (domain)
- [[effect-v4-api]] — the v3 forms that no longer compile, and the v4 form to write instead
- [[s2s-patterns]] — graphBridge, cross-package calls, ARC token flow
- [[frontend-patterns]] — SolidJS, shared UI tokens, lazy loading
- [[design-tokens]] — the `ui-*` contract every shared component reads, the scales under it, and the conformance harness
- [[component-library]] — Zaidan/shadcn-style components in three layers (`@shared/ui` primitives, `@osn/auth-ui` ceremony views, `@cire/ui` house style), Kobalte primitives, CVA variants
- [[drag-and-drop]] — `@shared/sortable` for drag-to-reorder, multi-container lists, and the keyboard + announcement path it owns
- [[rate-limiting]] — per-IP fixed-window rate limiting on auth endpoints
- [[turnstile]] — Cloudflare Turnstile bot protection (key-optional, fail-closed; shipped inert)
- [[email]] — transactional mail through `@shared/email`: the Resend, Cloudflare, log and no-op transports, and how one is chosen
- [[feature-flags]] — GrowthBook flags via `@shared/feature-flags`, key-optional and fail-safe
- [[d1-limits]] — D1's 100 bound parameters and 5 compound-select terms, and why `bun:sqlite` never sees either
- [[d1-read-replication]] — the Sessions API, why every request opens one `first-primary` session, and how to turn replicas on
- [[platform-limits]] — MAX_EVENT_GUESTS and other caps
- [[redis]] — Redis-backed rate limiters + cluster-safe auth state stores
- [[toast]] — `@shared/toast`, the `--toast-*` theming contract, and contrast on the surface a toast actually sits on
- [[database-environments]] — four DB environments (local bun:sqlite / dev·staging·prod D1), driver-agnostic Drizzle seam, D1 transaction caveat
- [[dev-environment]] — the isolated cire + OSN dev tier: tier map, how a merge deploys dev, how to promote to production past the approval gate, how to reset dev by hand
- [[production-deploy]] — first production cut-over of osn-api + the cire stack (secret/var checklist, migrations, CI pipeline, smoke checks)
- [[free-tier-limits]] — provider free-tier ceilings (Upstash / Workers / D1 / Pages / Turnstile / WAF), what breaks at each cap, the unavailability playbook, and the Cloudflare security-hardening TODO
- [[rate-limit-incident]] — false positives, tuning, Redis health
- [[bun-1.4-migration]] — what Bun 1.4 is worth using here: adopted (`$` shell, `Bun.TOML` guard, bun-types), impossible (`Bun.Image` in the seed), and what is left

### Observability

- [[shared/observability/overview]] — three golden rules, package layout, Grafana Cloud
- [[logging]] — Effect.log rules, redaction, log levels
- [[tracing]] — Effect.withSpan, span naming, traceparent propagation
- [[metrics]] — naming convention, typed attributes, cardinality enforcement
- [[feature-checklist]] — per-feature observability checklist
- [[observability-setup]] — Grafana Cloud provisioning, OTEL wiring

## OSN

The identity core: accounts, sessions, passkeys, step-up, OIDC, ARC tokens, the social graph.

- [[account-recovery-factors]] — TOTP and email-verified recovery: the restricted `osn-recovery` session, the step-up allow-lists, the provenance cooldown, and the six issues they split into
- [[arc-tokens]] — S2S authentication protocol (ES256, scoped JWTs)
- [[identity-model]] — accounts, profiles (users), organisations, multi-account
- [[verified-identity]] — Yoti-style verified-attribute layer (Australian DVS / mDL / myID; SD-JWT VC) — design doc, not yet implemented
- [[passkey-primary]] — passkey-only login contract (the only primary factor)
- [[recovery-codes]] — single-use account-recovery tokens (Copenhagen Book M2)
- [[step-up]] — short-lived sudo tokens gating sensitive endpoints (M-PK1)
- [[totp]] — RFC 6238 authenticator-app second factor: the encrypted secret, single use, the per-account lockout
- [[sessions]] — session introspection, per-device revocation, "sign out everywhere else", device/passkey management UI
- [[oidc-provider]] — OpenID Connect provider: how other apps recognise an OSN account without holding a passkey
- [[social-graph]] — connections, blocks
- [[osn-core]] — identity / auth stack (`@osn/api` + SDK + UI)
- [[auth-failure]] — passkey / recovery / refresh / step-up debugging
- [[arc-token-debugging]] — verification failures, key rotation

## Musubi

Our identity and social app, its consent screen and marketing site.

- [[social]] — identity & social-graph management UI (`@musubi/social`)
- [[social-mobile-ux]] — mobile UX audit + phased responsive-shell plan for `@musubi/social`
- [[authorize-ui]] — the OIDC consent screen (`/authorize` in `@musubi/social`)
- [[osn-landing]] — marketing site for OSN (`@musubi/landing`) — dark/dotted, connections-led
- [[musubi-identity-migration]] — moving osn-api to `id.musubi.social` and making musubi.social the OSN identity home (blockers, credential bridge, config inventory, cutover order)

## Pulse

Events.

- [[pulse-close-friends]] — Pulse-scoped close-friends list (feed boost + hosting affordance)
- [[pulse-onboarding]] — Pulse first-run onboarding flow (account-keyed, themed illustrations)
- [[event-access]] — loadVisibleEvent, public/private visibility gate
- [[venues]] — org-scoped venues, event lineups, venue detail page + Explore map layer
- [[pulse]] — events app (`@pulse/web` + `@pulse/api` + `@pulse/db`)
- [[pulse-landing]] — marketing site for Pulse events (`@pulse/landing`) — colourful + fun
- [[event-visibility-bug]] — private event leaks, loadVisibleEvent

## Cire

Weddings: guest site, organiser portal, vendor portal, API.

- [[cire-platform-plan]] — cire's build plan from digital invite to wedding-management platform
- [[cire-invite-builder]] — organiser-editable invite images + copy (slots, storage, API, guest rendering)
- [[cire-guest-event-editor]] — the interactive events + guests editor alongside the CSV schema
- [[cire-consent]] — cire's site-wide cookie/third-party consent: categories, vendor registry, the `__Host-cire_consent` record
- [[cire-host-portal-layout]] — how the organiser portal decides widths: `page-frame`, `auto-grid`, named container queries
- [[cire-auth]] — Cire's two-system auth (guest claim-code sessions + organiser OSN passkeys)
- [[cire-organiser]] — the cire organiser overview surface
- [[cire-budget]] — cire budget lines and spend roll-ups
- [[cire-checklist-tasks]] — the cire planning checklist / tasks module
- [[cire-entitlements]] — per-wedding capability gates
- [[cire-upgrades]] — self-serve purchase of a locked module: catalogue, platform Stripe checkout, the webhook that grants
- [[cire-invite-designs]] — the invite design selector
- [[cire-registry]] — the gift registry: list, household claims, gift log, one-primary-currency money rule
- [[cire-rsvp-deadline]] — the "respond by" date and how the invite locks past it
- [[cire-plus-ones]] — a guest's plus-one: the organiser's permission, the household's naming, how the change pipeline treats them
- [[cire-vendors]] — vendor directory, CRM, and the email-verification claim
- [[cire-workerd]] — what cire does differently on workerd (no OTel SDK, deferred export)
- [[cire]] — wedding-invite stack (`@cire/invites` + `@cire/host` + `@cire/api` + `@cire/db`)
- [[cire-development]] — cire's own build conventions: backend patterns, the two test tiers, its commands
- [[cire-landing]] — marketing site for the apex `cireweddings.com` (`@cire/landing`) + domain-migration / platform roadmap
- [[stripe-webhooks]] — cire-api's two Stripe endpoints (Connect for gifts, platform for upgrades): which events each takes, how to recreate one in the dashboard, the two local forwarders, and how to verify a deployed tier

## Zap

Messaging.

- [[zap]] — messaging app (`@zap/api` + `@zap/db` scaffolded; client app planned)

## Conventions

How we work: tests, comments, commands, pull requests, agent tooling.

- [[session-metrics]] — per-PR agent cost cards: schema, the declared-complexity comparison, DuckDB queries
- [[testing-patterns]] — it.effect, createTestLayer, route tests
- [[browser-tests]] — the real-Chromium Vitest project: what belongs in it and why jsdom can't cover it
- [[commands]] — CLI commands reference
- [[devloop-urls]] — named HTTPS hosts per app, one dev stack per worktree
- [[review-findings]] — finding ID format (S-H1, P-W2, T-M1)
- [[code-comments]] — what a comment is for, the four references that rot, the TSDoc tags to use
- [[contributing]] — PR workflow, changesets, branching
- [[stacked-prs]] — basing one PR on another with the gh CLI, and merging the stack
- [[component-lab]] — the in-repo Storybook replacement: prototyping components, three.js and canvas
- [[bundle-size-guards]] — the two rules any guard that gates on a number obeys, and the guards that hold them: per-app Astro bundle size, the src/pages test-route check, D1 migration-cost, and the monorepo-wide lint-warning ceiling
- [[wiki-search]] — the three ways to search this vault, which exist where, and the guard that stops a branch reading stale
- [[house-lint-rules]] — the `house/*` oxlint rules this repo writes for itself, and the code rule each one enforces
- [[agent-tooling]] — where agent sessions start, skills and their evals, third-party skills, subagent definitions, the vendored lint plugin
- [[github-issues-setup]] — the labels, issue types and Project behind the two issue repositories

## Decisions

One page per choice made between named alternatives, with the reasoning that
decided it — see [[decisions/README]] for what belongs here and what does not. Questions still open are in [[deferred-decisions]].

- [[native-dialog-over-kobalte]] — `@shared/ui`'s `Modal` is the platform `<dialog>`, not Kobalte's: the bundle measurement, and which of the two to reach for
- [[org-comember-fanout-batched-union]] — batched `UNION ALL` with a per-organisation `LIMIT`, over a global `LIMIT`, a window function or `json_each()`
- [[post-rank-connection-recheck-over-d1-batch]] — a bounded re-check after ranking, over a `db.batch()` that would rest on undocumented D1 isolation
- [[d1-migration-cost-budget-calibration]] — why the migration-cost guard prices a chain offline at 27 D1 rows per schema write
- [[rsvp-dwell-as-budget-with-announcement-floor]] — the cire RSVP dwell is a budget spent from the click, floored by what VoiceOver needs to speak
- [[top-layer-over-z-index-stack]] — nothing in cire's stacking scale ranks against a sheet: the top layer, entered later, over a bigger number
- [[closing-band-width-bound-over-height-clip]] — the closing band takes the crop's aspect, and its height bound is applied to the width so nothing is clipped
- [[d1-session-first-primary]] — one D1 session per request, `first-primary` Worker-wide, over a per-route constraint

## Compliance

- [[compliance/index]] — map of content for the compliance programme
- [[compliance/scope-matrix]] — which laws apply to which user / surface
- [[compliance/gdpr]] — GDPR + UK GDPR controls, gaps, and project changes
- [[compliance/soc2]] — SOC 2 Trust Services Criteria, control inventory, audit prep
- [[compliance/ccpa]] — CCPA / CPRA + state privacy law deltas
- [[compliance/dsa]] — EU Digital Services Act notice-and-action + transparency
- [[compliance/coppa]] — under-13 hard-gate strategy
- [[compliance/eaa]] — European Accessibility Act / WCAG 2.1 AA
- [[compliance/eprivacy]] — cookie law posture (compliant by absence)
- [[compliance/data-map]] — Article 30 record of processing activities
- [[compliance/subprocessors]] — third-party processor register + DPA status
- [[compliance/retention]] — per-table retention schedule
- [[compliance/dsar]] — DSAR runbook (access / erasure / portability / rectification)
- [[compliance/breach-response]] — 72-hour notification clock + incident runbook
- [[compliance/access-control]] — SOC 2 CC6 production access matrix
- [[compliance/backup-dr]] — SOC 2 A1 backup + DR plan + restore drills
