---
"@shared/observability": patch
---

Dependency security sweep — clears all 8 `bun audit` findings (2 high, 5
moderate, 1 low) and rolls compatible minors.

- **`@shared/observability`**: bump OpenTelemetry SDKs to `2.8.0` /
  exporters to `0.219.0`, fixing the only runtime-reaching advisory
  (GHSA-8988-4f7v-96qf — unbounded memory allocation in W3C Baggage
  propagation, `@opentelemetry/core` <2.8.0).
- **Root `overrides`** (dev/build/test toolchain, never enters the Worker
  isolate): `ws ^8.21.0` (high — GHSA-96hv DoS), `vite ^7.3.5` (high —
  `server.fs.deny` bypass, also clears the `launch-editor` moderate),
  `yaml ^2.9.0`, `js-yaml ^4.2.0`, `@babel/core ^7.29.7` (low),
  `@opentelemetry/core ^2.8.0` (forces the patched core through
  `@effect/opentelemetry`).
- Compatible minors via `bun update`: effect 3.21.3, elysia 1.4.29,
  turbo 2.9.18, lefthook 2.1.9, wrangler/vitest/miniflare.

Deferred (documented, not actioned): `cropperjs` 1→2 and `vite` 7→8 are
majors — vite 8 is blocked by Astro 6 pinning vite 7. `oxlint` is held at
1.61.0 (pinned); 1.70 tightens vitest rules and surfaces pre-existing
test-file lint errors, so that upgrade + cleanup is a separate PR. `bun
audit` is now clean.
