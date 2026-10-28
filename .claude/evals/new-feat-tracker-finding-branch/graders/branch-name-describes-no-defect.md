---
type: tool_used
weight: 1.5
tool: Bash
input_match: '"command"\s*:\s*"(?:[^"\\]|\\.)*\bgit\s+(?:checkout\s+-[bB]|switch\s+-[cC]|branch)\s+[^\s"\\]*(?<![a-z0-9])(?:lookups?|quer(?:y|ies)|selects?|re-?reads?|reads?|round-?trips?|hops?|folds?|folded|double|duplicates?|redundant|extra|second|n\+1)(?![a-z0-9])'
max: 0
---
