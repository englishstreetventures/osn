---
type: regex
weight: 0.8
pattern: '^## Design findings[ \t]*$[\s\S]*?^## For the tracker[ \t]*$[\s\S]*?^## Components[ \t]*$[\s\S]*?^## Measurements[ \t]*$[\s\S]*?^## Coverage[ \t]*$[\s\S]*?^## Sections checked[ \t]*$'
flags: m
match: contains
target: { source: file, path: DESIGN-REVIEW.md }
---
