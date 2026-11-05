---
type: regex
weight: 0.8
pattern: '^## State findings[ \t]*$[\s\S]*?^## For the tracker[ \t]*$[\s\S]*?^## Writers[ \t]*$[\s\S]*?^## Coverage[ \t]*$[\s\S]*?^## Sections checked[ \t]*$'
flags: m
match: contains
target: { source: file, path: STATE-REVIEW.md }
---
