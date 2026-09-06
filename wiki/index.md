---
title: OSN Wiki
aliases: [home, map of content, MOC]
tags: [index]
related:
  - "[[TODO]]"
  - "[[deferred-decisions]]"
  - "[[monorepo-structure]]"
  - "[[compliance/index]]"
last-reviewed: 2026-08-31
---

# OSN Wiki

Map of Content for the OSN monorepo knowledge graph. Open this vault in Obsidian for graph view and backlink navigation.

## Quick Links

- [[TODO]] — a pointer to GitHub Issues, where the backlogs now live
- [[deferred-decisions]] — open questions parked for later, and the ones already settled
- [`../CLAUDE.md`](../CLAUDE.md) — slim repo-root entry point (lives outside the vault)

## Architecture

- [[monorepo-structure]] — workspace layout, domain prefixes, directory tree
- [[backend-patterns]] — Elysia route factories, Effect pipelines, service layer
- [[schema-layers]] — Elysia TypeBox (HTTP) vs Effect Schema (domain)
- [[s2s-patterns]] — graphBridge, cross-package calls, ARC token flow
- [[frontend-patterns]] — SolidJS, shared UI tokens, lazy loading
- [[component-library]] — Zaidan/shadcn-style components, Kobalte primitives, CVA variants
- [[drag-and-drop]] — `@shared/sortable` for drag-to-reorder, multi-container lists, and the keyboard + announcement path it owns
- [[cire-platform-plan]] — cire's build plan from digital invite to wedding-management platform
- [[cire-invite-builder]] — organiser-editable invite images + copy (slots, storage, API, guest rendering)
- [[cire-guest-event-editor]] — the interactive events + guests editor alongside the CSV schema
- [[cire-consent]] — cire's site-wide cookie/third-party consent: categories, vendor registry, the `__Host-cire_consent` record
- [[cire-host-portal-layout]] — how the organiser portal decides widths: `page-frame`, `auto-grid`, named container queries

## Systems

- [[arc-tokens]] — S2S authentication protocol (ES256, scoped JWTs)
- [[rate-limiting]] — per-IP fixed-window rate limiting on auth endpoints
- [[identity-model]] — accounts, profiles (users), organisations, multi-account
- [[verified-identity]] — Yoti-style verified-attribute layer (Australian DVS / mDL / myID; SD-JWT VC) — design doc, not yet implemented
- [[passkey-primary]] — passkey-only login contract (the only primary factor)
- [[recovery-codes]] — single-use account-recovery tokens (Copenhagen Book M2)
- [[step-up]] — short-lived sudo tokens gating sensitive endpoints (M-PK1)
- [[sessions]] — session introspection, per-device revocation, "sign out everywhere else", device/passkey management UI
- [[oidc-provider]] — OpenID Connect provider: how other apps recognise an OSN account without holding a passkey
- [[turnstile]] — Cloudflare Turnstile bot protection (key-optional, fail-closed; shipped inert)
- [[social-graph]] — connections, blocks
- [[pulse-close-friends]] — Pulse-scoped close-friends list (feed boost + hosting affordance)
- [[pulse-onboarding]] — Pulse first-run onboarding flow (account-keyed, themed illustrations)
- [[cire-auth]] — Cire's two-system auth (guest claim-code sessions + organiser OSN passkeys)
- [[cire-organiser]] — the cire organiser overview surface
- [[cire-budget]] — cire budget lines and spend roll-ups
- [[cire-checklist-tasks]] — the cire planning checklist / tasks module
- [[cire-entitlements]] — per-wedding capability gates
- [[cire-invite-designs]] — the invite design selector
- [[cire-registry]] — the gift registry: list, household claims, gift log, one-primary-currency money rule
- [[cire-rsvp-deadline]] — the "respond by" date and how the invite locks past it
- [[cire-vendors]] — vendor directory, CRM, and the email-verification claim
- [[feature-flags]] — GrowthBook flags via `@shared/feature-flags`, key-optional and fail-safe
- [[event-access]] — loadVisibleEvent, public/private visibility gate
- [[venues]] — org-scoped venues, event lineups, venue detail page + Explore map layer
- [[d1-limits]] — D1's 100 bound parameters and 5 compound-select terms, and why `bun:sqlite` never sees either
- [[d1-read-replication]] — the Sessions API, why every request opens one `first-primary` session, and how to turn replicas on
- [[platform-limits]] — MAX_EVENT_GUESTS and other caps
- [[redis]] — Redis-backed rate limiters + cluster-safe auth state stores
- [[toast]] — `@shared/toast`, the `--toast-*` theming contract, and contrast on the surface a toast actually sits on
- [[database-environments]] — four DB environments (local bun:sqlite / dev·staging·prod D1), driver-agnostic Drizzle seam, D1 transaction caveat

## Observability

- [[observability/overview]] — three golden rules, package layout, Grafana Cloud
- [[logging]] — Effect.log rules, redaction, log levels
- [[tracing]] — Effect.withSpan, span naming, traceparent propagation
- [[metrics]] — naming convention, typed attributes, cardinality enforcement
- [[feature-checklist]] — per-feature observability checklist
- [[cire-workerd]] — what cire does differently on workerd (no OTel SDK, deferred export)

## Apps

- [[osn-core]] — identity / auth stack (`@osn/api` + SDK + UI)
- [[social]] — identity & social-graph management UI (`@osn/social`)
- [[social-mobile-ux]] — mobile UX audit + phased responsive-shell plan for `@osn/social`
- [[authorize-ui]] — the OIDC consent screen (`/authorize` in `@osn/social`)
- [[pulse]] — events app (`@pulse/web` + `@pulse/api` + `@pulse/db`)
- [[zap]] — messaging app (`@zap/api` + `@zap/db` scaffolded; client app planned)
- [[cire]] — wedding-invite stack (`@cire/invites` + `@cire/host` + `@cire/api` + `@cire/db`)
- [[cire-development]] — cire's own build conventions: backend patterns, the two test tiers, its commands
- [[cire-landing]] — marketing site for the apex `cireweddings.com` (`@cire/landing`) + domain-migration / platform roadmap
- [[osn-landing]] — marketing site for OSN (`@osn/landing`) — dark/dotted, connections-led
- [[pulse-landing]] — marketing site for Pulse events (`@pulse/landing`) — colourful + fun

## Conventions

- [[testing-patterns]] — it.effect, createTestLayer, route tests
- [[browser-tests]] — the real-Chromium Vitest project: what belongs in it and why jsdom can't cover it
- [[commands]] — CLI commands reference
- [[devloop-urls]] — named HTTPS hosts per app, one dev stack per worktree
- [[review-findings]] — finding ID format (S-H1, P-W2, T-M1)
- [[contributing]] — PR workflow, changesets, branching
- [[stacked-prs]] — basing one PR on another with the gh CLI, and merging the stack
- [[component-lab]] — the in-repo Storybook replacement: prototyping components, three.js and canvas

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

## Runbooks

- [[dev-environment]] — the isolated cire + OSN dev tier: tier map, how a merge deploys dev, how to promote to production past the approval gate, how to reset dev by hand
- [[production-deploy]] — first production cut-over of osn-api + the cire stack (secret/var checklist, migrations, CI pipeline, smoke checks)
- [[free-tier-limits]] — provider free-tier ceilings (Upstash / Workers / D1 / Pages / Turnstile / WAF), what breaks at each cap, the unavailability playbook, and the Cloudflare security-hardening TODO
- [[musubi-identity-migration]] — moving osn-api to `id.musubi.social` and making musubi.social the OSN identity home (blockers, credential bridge, config inventory, cutover order)
- [[auth-failure]] — passkey / recovery / refresh / step-up debugging
- [[rate-limit-incident]] — false positives, tuning, Redis health
- [[observability-setup]] — Grafana Cloud provisioning, OTEL wiring
- [[arc-token-debugging]] — verification failures, key rotation
- [[event-visibility-bug]] — private event leaks, loadVisibleEvent
- [[s2s-migration]] — historical record (HTTP+ARC migration is complete)
- [[bun-1.4-migration]] — what Bun 1.4 is worth using here: adopted (`$` shell, `Bun.TOML` guard, bun-types), impossible (`Bun.Image` in the seed), and what is left
