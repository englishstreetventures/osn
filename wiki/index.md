---
title: OSN Wiki
aliases: [home, map of content, MOC]
tags: [index]
last-reviewed: 2026-06-18
---

# OSN Wiki

Map of Content for the OSN monorepo knowledge graph. Open this vault in Obsidian for graph view and backlink navigation.

## Quick Links

- [[TODO]] — progress tracking, backlogs, deferred decisions
- [`../CLAUDE.md`](../CLAUDE.md) — slim repo-root entry point (lives outside the vault)

## Architecture

- [[monorepo-structure]] — workspace layout, domain prefixes, directory tree
- [[backend-patterns]] — Elysia route factories, Effect pipelines, service layer
- [[schema-layers]] — Elysia TypeBox (HTTP) vs Effect Schema (domain)
- [[s2s-patterns]] — graphBridge, cross-package calls, ARC token flow
- [[frontend-patterns]] — SolidJS, Tauri, shared UI tokens, lazy loading
- [[component-library]] — Zaidan/shadcn-style components, Kobalte primitives, CVA variants

## Systems

- [[arc-tokens]] — S2S authentication protocol (ES256, scoped JWTs)
- [[rate-limiting]] — per-IP fixed-window rate limiting on auth endpoints
- [[identity-model]] — accounts, profiles (users), organisations, multi-account
- [[verified-identity]] — Yoti-style verified-attribute layer (Australian DVS / mDL / myID; SD-JWT VC) — design doc, not yet implemented
- [[passkey-primary]] — passkey-only login contract (the only primary factor)
- [[recovery-codes]] — single-use account-recovery tokens (Copenhagen Book M2)
- [[step-up]] — short-lived sudo tokens gating sensitive endpoints (M-PK1)
- [[sessions]] — session introspection, per-device revocation, "sign out everywhere else", device/passkey management UI
- [[turnstile]] — Cloudflare Turnstile bot protection (key-optional, fail-closed; shipped inert)
- [[social-graph]] — connections, blocks
- [[pulse-close-friends]] — Pulse-scoped close-friends list (feed boost + hosting affordance)
- [[pulse-onboarding]] — Pulse first-run onboarding flow (account-keyed, themed illustrations)
- [[cire-auth]] — Cire's two-system auth (guest claim-code sessions + organiser OSN passkeys)
- [[event-access]] — loadVisibleEvent, public/private visibility gate
- [[venues]] — org-scoped venues, event lineups, venue detail page + Explore map layer
- [[platform-limits]] — MAX_EVENT_GUESTS and other caps
- [[redis]] — Redis-backed rate limiters + cluster-safe auth state stores
- [[database-environments]] — four DB environments (local bun:sqlite / dev·staging·prod D1), driver-agnostic Drizzle seam, D1 transaction caveat

## Observability

- [[observability/overview]] — three golden rules, package layout, Grafana Cloud
- [[logging]] — Effect.log rules, redaction, log levels
- [[tracing]] — Effect.withSpan, span naming, traceparent propagation
- [[metrics]] — naming convention, typed attributes, cardinality enforcement
- [[feature-checklist]] — per-feature observability checklist

## Apps

- [[osn-core]] — identity / auth stack (`@osn/api` + SDK + UI)
- [[social]] — identity & social-graph management UI (`@osn/social`)
- [[pulse]] — events app (`@pulse/app` + `@pulse/api` + `@pulse/db`)
- [[zap]] — messaging app (`@zap/api` + `@zap/db` scaffolded; client app planned)
- [[cire]] — wedding-invite stack (`@cire/web` + `@cire/organiser` + `@cire/api` + `@cire/db`)
- [[cire-landing]] — marketing site for the apex `cireweddings.com` (`@cire/landing`) + domain-migration / platform roadmap
- [[osn-landing]] — marketing site for OSN (`@osn/landing`) — dark/dotted, connections-led
- [[pulse-landing]] — marketing site for Pulse events (`@pulse/landing`) — colourful + fun

## Conventions

- [[testing-patterns]] — it.effect, createTestLayer, route tests
- [[commands]] — CLI commands reference
- [[review-findings]] — finding ID format (S-H1, P-W2, T-M1)
- [[contributing]] — PR workflow, changesets, branching

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

## Changelog

- [[changelog/completed-features]] — archived completed feature work
- [[changelog/security-fixes]] — archived completed security findings
- [[changelog/performance-fixes]] — archived completed performance findings
- [[changelog/compliance-fixes]] — archived closed compliance findings (`C-` prefix)

## Runbooks

- [[production-deploy]] — first production cut-over of osn-api + the cire stack (secret/var checklist, migrations, CI pipeline, smoke checks)
- [[free-tier-limits]] — provider free-tier ceilings (Upstash / Workers / D1 / Pages / Turnstile / WAF), what breaks at each cap, the unavailability playbook, and the Cloudflare security-hardening TODO
- [[auth-failure]] — passkey / recovery / refresh / step-up debugging
- [[rate-limit-incident]] — false positives, tuning, Redis health
- [[observability-setup]] — Grafana Cloud provisioning, OTEL wiring
- [[arc-token-debugging]] — verification failures, key rotation
- [[event-visibility-bug]] — private event leaks, loadVisibleEvent
- [[s2s-migration]] — historical record (HTTP+ARC migration is complete)
