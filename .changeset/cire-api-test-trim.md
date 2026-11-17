---
"@cire/api": patch
"@cire/infra": patch
---

Tests only: 187 `@cire/api` test cases go (184 that another test already checks, each cover seen failing with the deleted case's line broken, and 3 that could not fail), and one `@cire/infra` case that KP3 already checks. `bun run --cwd cire/api test` no longer runs the Miniflare D1 suite, which `test:d1` runs. Six cases stop waiting on the real clock, and about 30 checks that could not fail now can.
