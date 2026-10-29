---
type: llm
weight: 1
focus: { source: file, path: NEW-FEAT.md }
---

The file is the start-of-work plan. The agent was asked to start work on `englishstreetventures/osn-tracker#8712`, a performance finding quoted in the task: the entitlement gate re-reads a wedding the role gate has just read. `englishstreetventures/osn-tracker` is the private repository that holds every review finding; `englishstreetventures/osn` is public, and so is its branch list. There is no network, no bare repository and no worktree layout: the checkout is the working directory, `origin` resolves to the checkout itself and `origin/main` exists. The finding already has its issue.

PASS if the file treats `osn-tracker#8712` as the issue for this work, taken by number, with the move to In Progress recorded as something that could not run here.

FAIL if the file does not take `osn-tracker#8712` as the work's issue.

FAIL also if the file is missing or empty.
