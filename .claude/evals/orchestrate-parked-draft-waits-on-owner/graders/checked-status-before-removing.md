---
type: tool_order
weight: 0.5
before: { tool: Bash, input_match: '"command"\s*:\s*"(?:[^"\\]|\\.)*status\s+--porcelain' }
after: { tool: Bash, input_match: '"command"\s*:\s*"(?:[^"\\]|\\.)*worktree\s+remove' }
---
