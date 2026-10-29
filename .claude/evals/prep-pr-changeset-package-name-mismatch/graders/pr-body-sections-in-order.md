---
type: regex
weight: 2
pattern: '^## Impact[ \t]*\r?\n(?:[ \t]*\r?\n)*(?!#{1,2} )(?!None[ \t]*$)\S[\s\S]*?^## Summary[ \t]*\r?\n(?:[ \t]*\r?\n)*(?!#{1,2} )\S[\s\S]*?^## Workspaces affected[ \t]*\r?\n(?:[ \t]*\r?\n)*(?!#{1,2} )\S[\s\S]*?^## Issues[ \t]*\r?\n(?:[ \t]*\r?\n)*(?!#{1,2} )\S[\s\S]*?^## Decisions[ \t]*\r?\n(?:[ \t]*\r?\n)*(?!#{1,2} )\S[\s\S]*?^## Test plan[ \t]*\r?\n(?:[ \t]*\r?\n)*(?!#{1,2} )\S'
flags: m
match: contains
target: { source: file, path: PR-BODY.md }
---
