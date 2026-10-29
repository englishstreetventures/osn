---
type: regex
weight: 0.4
pattern: '^## '
flags: m
match: count:6
target: { source: file, path: PR-BODY.md }
---
