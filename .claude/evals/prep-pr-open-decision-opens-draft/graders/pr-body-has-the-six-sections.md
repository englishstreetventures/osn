---
type: regex
weight: 0.4
pattern: '^(?=[\s\S]*^## Impact[ \t]*\r?\n(?:[ \t]*\r?\n)*(?!#{1,2} )(?!None[ \t]*$)\S)(?=[\s\S]*^## Summary[ \t]*$)(?=[\s\S]*^## Workspaces affected[ \t]*$)(?=[\s\S]*^## Issues[ \t]*$)(?=[\s\S]*^## Decisions[ \t]*$)(?=[\s\S]*^## Test plan[ \t]*$)'
flags: m
match: contains
target: { source: file, path: PR-BODY.md }
---
