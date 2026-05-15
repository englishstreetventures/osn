---
---

Supply-chain hardening: add `bunfig.toml` with `telemetry = false` and `minimumReleaseAge = 259200` (3 days); add `bun audit --audit-level=critical` to lefthook pre-push; override `protobufjs ^7.5.5` to resolve transitive critical CVE via `@opentelemetry/exporter-*-otlp-http`; bump ready patch versions across the monorepo (`vitest`, `jose`, `@elysiajs/cors`, `@opentelemetry/sdk-*`, `astro`, `@astrojs/check`, `@vitest/coverage-istanbul`).
