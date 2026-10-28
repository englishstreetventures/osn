---
type: regex
weight: 1
pattern: '^## Issues[ \t]*\r?\n(?:(?!^## )[\s\S])*?^Closes #1402[ \t]*$(?:(?!^## )[\s\S])*?^Closes englishstreetventures/osn-tracker#598[ \t]*$'
flags: m
match: contains
target: { source: file, path: PR-BODY.md }
---
