---
title: S2S Migration (historical)
description: Historical record of the direct-import → HTTP+ARC S2S migration. Migration is complete.
tags: [runbook, s2s, arc, migration, historical]
severity: low
status: completed
related:
  - "[[arc-tokens]]"
  - "[[s2s-patterns]]"
  - "[[arc-token-debugging]]"
last-reviewed: 2026-04-23
---

# S2S Migration — Historical Record

> **Status: complete.** `@pulse/api` reaches `@osn/api` exclusively via HTTP + ARC tokens through `pulse/api/src/services/graphBridge.ts`. There is no longer a direct-import path. This page is retained as the post-mortem of the migration; for the live architecture, read [[s2s-patterns]] and [[arc-tokens]].

## What changed

| Before | After |
|---|---|
| `@pulse/api` imported `createGraphService()` from a separate `@osn/core` library | `@osn/core` is gone; `@osn/api` is the only OSN runtime |
| In-process function calls; no network, no token | HTTP calls to `@osn/api` `/graph/internal/*` with `Authorization: ARC <jwt>` |
| Rate limits worked only inside one process | Redis-backed per-IP / per-user limiters cross-process |
| No audit surface for cross-domain reads | Every call has an `iss`, an `aud`, a scope, and a kid logged on the receiver |

## Why it mattered

- **Multi-process / horizontal scaling** — a direct import only works when both packages run in the same Bun process.
- **Third-party callers** — once the boundary is HTTP + ARC, third-party services slot in with the same auth contract.
- **Observability** — distributed traces now link the call across services because `instrumentedFetch` injects `traceparent`.

## Bridge pattern, retained

The `graphBridge.ts` indirection survives the migration intact: every cross-boundary call still routes through that one file. The transport changed; the seam did not. That seam is what made the migration a single-file edit and what now makes adding a new cross-domain function a one-file change.

## If you need to re-do something like this

1. Establish the bridge pattern *before* you need it — one file owning every cross-boundary call.
2. Wire ARC verification middleware on the receiver first; reject anything anonymous on internal routes.
3. Switch the bridge from in-process to HTTP. Keep the same exported function shapes so callers don't move.
4. Confirm `traceparent` propagation by inspecting a single trace end-to-end before declaring done.

## Related

- [[arc-tokens]] — the live ARC token architecture and verification contract
- [[s2s-patterns]] — the live `graphBridge` design
- [[arc-token-debugging]] — operational runbook when ARC verification fails
