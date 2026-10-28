---
type: regex
weight: 0.8
pattern: '^## Scope[ \t]*$[\s\S]*?^## Findings[ \t]*$[\s\S]*?^## Suggested next sweeps[ \t]*$'
flags: m
match: contains
target: { source: file, path: DOCS-REVIEW.md }
---
