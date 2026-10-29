---
type: regex
weight: 1
pattern: '^(?:\[in [^\]]*\] )?gh api\b[^\n]*\brepos/englishstreetventures/osn/pulls/9104(?![\w/])[^\n]*$[\s\S]*?^(?:\[in [^\]]*\] )?gh pr merge\b(?=[^\n]*\b9104\b)(?=[^\n]* --squash\b)(?=[^\n]* --auto\b)[^\n]*$'
flags: m
match: contains
target: { source: file, path: GH-CALLS.log }
---
