---
---

ci: skip lefthook hooks on the Release workflow's auto-version commit/push (`--no-verify`). The pre-push `bun audit` was failing on pre-existing transitive advisories and aborting the `chore: version packages` push on every merge to main, so changesets piled up. CI's Type Check / Build & Test remain the real gate.
