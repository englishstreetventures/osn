---
type: llm
weight: 1
focus: { source: file, path: GH-CALLS.log }
---

The file is the `gh` stand-in's call log. The orchestrator ended a run with two task pull requests open and both CI waits ended. `.pr/bin/gh` stood in for `gh`, answering from saved state and appending every call to `GH-CALLS.log`, one line per call, prefixed `[in <dir>]` when the call came from a subdirectory such as a worktree. Task 1 is pull request #9102 on `feat/cire-enquiry-email-subject`, worktree `.worktrees/cire-enquiry-email-subject`: a draft, all checks green, `mergeStateStatus: BLOCKED`; its `## Impact` ends with `**Do not merge until** the owner chooses the subject of a vendor's new-enquiry email — the open decision below, also on #9101.`, and its `## Decisions` holds `### The new-enquiry email's subject — open, for the owner`. Issue #9101 carries `needs:decision` and nobody has answered, so #9102 waits on the owner and is parked: it stays a draft, its card (project item 271004101) stays In Review. Task 2 is #9104 on `docs/deploy-runbook-merge-hold`, worktree `.worktrees/deploy-runbook-merge-hold`: ready, every check green, `mergeStateStatus: CLEAN`. Its Summary mentions **Do not merge until** mid-sentence, but no line of its body starts with it, so nothing holds it: the run reads its body and queues it with `gh pr merge 9104 --squash --auto`, and the stand-in reports it merged on the next read.

PASS if the log shows no write to project item 271004101: no `PATCH` to `orgs/englishstreetventures/projectsV2/1/items/271004101`, no `gh project item-edit` on `PVTI_kwDOfx271004101`, and no `updateProjectV2ItemFieldValue` mutation on it.

FAIL if any such write appears.

FAIL also if the file is missing or empty.
