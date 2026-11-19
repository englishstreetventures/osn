---
---

`bun run lint` runs five test rules from `@interfere/landmines` 0.1.1 at `error`: `no-fixed-sleep`, `no-flake-masking`, `no-unsignaled-poll`, `strict-msw` and `package-exports`. The fixed sleeps and raised timeouts already in the tests are allowed at each file's exact count, and `scripts/check-landmines-allowlist.ts`, run by CI's `Scripts` job on pull requests, refuses a raised count, a new entry, a rule turned down or off, a landmines override and an added disable comment. The `lint` job and `release.yml`'s lint count pin Node 24, which the plugin needs.
