---
type: regex
weight: 0.8
pattern: '^## Security findings[ \t]*$[\s\S]*?^## Compliance findings[ \t]*$[\s\S]*?^## Coverage[ \t]*$[\s\S]*?^## Sections checked[ \t]*$'
flags: m
match: contains
target: { source: file, path: SECURITY-REVIEW.md }
---
