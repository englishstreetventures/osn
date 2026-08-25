---
---

chore: verify the vendored anti-slop oxlint plugin before it executes rather than in a parallel CI job, via a shared `scripts/verify-vendored-anti-slop.sh` called from the `lint` job and chained ahead of oxlint in the pre-commit hook.
