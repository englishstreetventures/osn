---
type: regex
weight: 0.8
pattern: '^(?=[\s\S]*import\s*(?:type\s*)?\{[^}]*\bcapGuestNote\b[^}]*\}\s*from\s*["''](?:\.\./){2}src/lib/guest-note(?:\.ts)?["''])(?=[\s\S]*import\s*(?:type\s*)?\{[^}]*\bGUEST_NOTE_MAX\b[^}]*\}\s*from\s*["''](?:\.\./){2}src/lib/guest-note(?:\.ts)?["''])(?=[\s\S]*from\s*["'']bun:test["''])(?=[\s\S]*\b(?:test|it)\s*\()'
flags: m
match: contains
target: { source: file, path: cire/api/tests/lib/guest-note.test.ts }
---
