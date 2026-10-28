---
type: regex
weight: 0.8
pattern: '^## Build[ \t]*$[\s\S]*?^## Tests[ \t]*$[\s\S]*?^## Coverage gaps[ \t]*$[\s\S]*?^## Files audited[ \t]*$[\s\S]*?^## Not run[ \t]*$'
flags: m
match: contains
target: { source: file, path: TEST-REVIEW.md }
---
