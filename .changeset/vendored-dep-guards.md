---
---

Enforce expiry and a bounded soak on `minimumReleaseAgeExcludes` entries, and a floor on `minimumReleaseAge` itself, in CI — the checker now actually runs as a `script-tests` step instead of only under `bun test`. Vendor the MIT licence for the anti-slop oxlint plugin, check the vendored tree's file set (not just its listed checksums) against a committed SHA256SUMS in CI, fix the re-vendor recipe so it reproduces that file byte for byte, and extend CODEOWNERS to the guard scripts and configs themselves.
