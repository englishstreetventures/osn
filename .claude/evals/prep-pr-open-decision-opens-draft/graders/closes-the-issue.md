---
type: regex
weight: 1
pattern: '^## Issues[ \t]*\r?\n(?:(?!^## )[\s\S])*?^Closes #9131[ \t]*$'
flags: m
match: contains
target: { source: file, path: PR-BODY.md }
---
