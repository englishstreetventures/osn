---
type: tool_used
weight: 0.1
tool: Bash
input_match: '"command"\s*:\s*"(?:[^"\\]|\\.)*\bgh\s+(?:(?:-R|--repo)[\s=]+\S+\s+)?(?:(?:issue\s+(?:create|edit|close|comment)|pr\s+(?:create|edit|merge|ready))(?![\w-])|api\s+(?:(?:[^"\\]|\\.)*?\s)?(?:-X|--method)[\s=]*(?:POST|PATCH|PUT|DELETE)\b)'
max: 0
---
