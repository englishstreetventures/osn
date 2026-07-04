---
"@osn/api": patch
"@osn/client": minor
"@pulse/api": patch
"@pulse/app": minor
"@zap/api": patch
---

Code-quality sweep: lint-config repair + convention fixes monorepo-wide.

- oxlint config: pin rules that leaked in via an upstream category re-shuffle
  (`no-underscore-dangle` off — Effect `_tag` is idiomatic;
  `unicorn/consistent-function-scoping` off — boot-time factory modules and
  Effect-context DI make it noise; `no-await-in-loop` off in tests), raise
  `jsx-a11y/control-has-associated-label` depth for Solid control-flow
  wrappers. 463 → 21 warnings; the survivors are the deliberate aspirational
  jsx-a11y set.
- S-M5 (osn): `/account` erasure endpoints now thread `clientIpConfig` +
  socket peer into per-IP rate-limit keying (spoofable XFF no longer picks
  the bucket; unresolved IPs are denied, S-M34 posture) — with route tests.
- pulse/api + zap/api route factories now build their Effect layer graph once
  per factory via `ManagedRuntime` instead of `Effect.provide(dbLayer)` inside
  every request (convention: `osn/api/src/lib/route-runtime.ts`); dead
  pre-instantiated route-group exports removed.
- Dead exports removed: `decodeSession` (@osn/client), `getHandleFromToken`
  (@pulse/app).
- Assorted lint fixes: variable shadowing renames, unused imports, promise
  handling in `TurnstileWidget`, `toSorted` in tests.
