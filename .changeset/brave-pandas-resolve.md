---
"@tools/pr-metrics": patch
---

Resolve the default `.claude/metrics` against the repository root rather than the working directory.

Every documented invocation is `bun run --cwd tools/pr-metrics <command>`, and `--cwd` sets the process working directory — so a default of `.claude/metrics` pointed at `tools/pr-metrics/.claude/metrics`, which does not exist. `report` exited 1 on the exact command printed in its own README, and `backfill` and `card` wrote to a stray directory inside the package.

`card` is the one that did real damage. The `SessionEnd` hook runs it and ends in `|| true`, so every card the hook has ever written went into the package and the failure was swallowed. That is why the seeded corpus arrived by a commit rather than from the hook that was supposed to produce it.

A regression test runs the collector from inside a package subdirectory and asserts the card lands at the repository root and not under the package.
