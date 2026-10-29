---
type: regex
weight: 0.8
pattern: '^(?=.*\bPATCH\b)(?=.*items/271004101\b).*$|^(?=.*\bproject item-edit\b)(?=.*PVTI_kwDOfx271004101).*$|^(?=.*updateProjectV2ItemFieldValue)(?=.*271004101).*$'
flags: m
match: not_contains
target: { source: file, path: GH-CALLS.log }
---
