---
type: regex
weight: 0.8
pattern: '^## Performance findings[ \t]*$[\s\S]*?^## Measurements[ \t]*$[\s\S]*?^## Coverage[ \t]*$[\s\S]*?^## Sections checked[ \t]*$'
flags: m
match: contains
target: { source: file, path: PERFORMANCE-REVIEW.md }
---
