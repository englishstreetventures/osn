---
---

Add the `/orchestrate` slash command — automates the full task loop (gather context → prep worktree → hand off to a subagent that uses `/new-feat` → `/prep-pr` with findings fixed not just reported → watch the PR and squash-merge when green / resolve conflicts), for one or more tasks ordered by the orchestrator; bare-repo-root only. Also adds a "skills to use while implementing" routing table to `/new-feat`.
