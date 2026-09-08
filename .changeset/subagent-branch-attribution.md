---
"@tools/pr-metrics": patch
---

Attribute a subagent's spend to the branch it worked on. `gitBranch` is captured
once per session and inherited, so delegated work was recorded against the
orchestrator's branch — 85.8% of subagent spend stamped `HEAD`. The collector now
reads a `TASK-BRANCH:` marker back out of the dispatch prompt, inherits it down
nested dispatches, and de-duplicates records that appear in two session files.
