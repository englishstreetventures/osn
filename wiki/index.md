---
title: OSN Wiki
aliases: [home, map of content, MOC]
tags: [index]
last-reviewed: 2026-04-14
---

# OSN Wiki

Map of Content for the OSN monorepo knowledge graph. Open this vault in Obsidian for graph view and backlink navigation.

## Quick Links

- [[TODO]] — progress tracking, backlogs, deferred decisions

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
- [[recovery-codes]] — single-use account-recovery tokens (Copenhagen Book M2)
- [[step-up]] — short-lived sudo tokens gating sensitive endpoints (M-PK1)
- [[sessions]] — session introspection, per-device revocation, "sign out everywhere else"
- [[social-graph]] — connections, close friends, blocks
- [[close-friends]] — one-way graph edge, RSVP visibility, UI treatment
- [[event-access]] — loadVisibleEvent, public/private visibility gate
- [[platform-limits]] — MAX_EVENT_GUESTS and other caps
- [[redis]] — Redis migration plan (rate limiters + auth state)

## Observability

- [[observability/overview]] — three golden rules, package layout, Grafana Cloud
- [[logging]] — Effect.log rules, redaction, log levels
- [[tracing]] — Effect.withSpan, span naming, traceparent propagation
- [[metrics]] — naming convention, typed attributes, cardinality enforcement
- [[feature-checklist]] — per-feature observability checklist

## Apps

- [[osn-core]] — identity/auth stack (@osn/core + @osn/api)
- [[social]] — identity & social-graph management UI (@osn/social)
- [[pulse]] — events app (@pulse/app + @pulse/api + @pulse/db)
- [[zap]] — messaging app (placeholder, M0-M5 roadmap)
- [[landing]] — marketing site (@osn/landing)

## Conventions

- [[testing-patterns]] — it.effect, createTestLayer, route tests
- [[commands]] — CLI commands reference
- [[review-findings]] — finding ID format (S-H1, P-W2, T-M1)
- [[contributing]] — PR workflow, changesets, branching

## Changelog

- [[changelog/completed-features]] — archived completed feature work
- [[changelog/security-fixes]] — archived completed security findings
- [[changelog/performance-fixes]] — archived completed performance findings

## Runbooks

- [[auth-failure]] — OTP/passkey/magic-link/PKCE debugging
- [[rate-limit-incident]] — false positives, tuning, Redis failover
- [[observability-setup]] — Grafana Cloud provisioning, OTEL wiring
- [[arc-token-debugging]] — verification failures, key rotation
- [[event-visibility-bug]] — private event leaks, loadVisibleEvent
- [[s2s-migration]] — direct import to HTTP+ARC migration
