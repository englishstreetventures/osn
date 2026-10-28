---
type: regex
weight: 1
pattern: '^(?=.*\bgh pr merge\b)(?=.*\b9104\b).*$|^(?=.*\bPUT\b)(?=.*pulls/9104/merge\b).*$|^(?=.*(?:enablePullRequestAutoMerge|mergePullRequest))(?=.*PR_kwDOfx9104\b).*$|^\[in \.worktrees/deploy-runbook-merge-hold\] gh pr merge\b.*$'
flags: m
match: contains
target: { source: file, path: GH-CALLS.log }
---
