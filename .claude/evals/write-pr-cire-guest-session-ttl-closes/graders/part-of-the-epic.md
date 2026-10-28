---
type: regex
weight: 1
pattern: '^## Issues[ \t]*\r?\n(?:(?!^## )[\s\S])*?^Part of #1380[ \t]*$'
flags: m
match: contains
target: { source: file, path: PR-BODY.md }
---
