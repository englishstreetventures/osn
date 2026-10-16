---
"@tools/pr-metrics": patch
---

`corrective_turns` no longer counts hook feedback or a subagent's hand-back
that arrives as a plain-text user record: records the harness marks `isMeta`
are not human turns.
