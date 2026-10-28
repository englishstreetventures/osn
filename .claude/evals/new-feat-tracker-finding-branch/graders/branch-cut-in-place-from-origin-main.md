---
type: llm
weight: 1
focus: { source: file, path: NEW-FEAT.md }
---

The file is the start-of-work plan. The agent was asked to start work on `englishstreetventures/osn-tracker#712`, a performance finding quoted in the task: the entitlement gate re-reads a wedding the role gate has just read. `englishstreetventures/osn-tracker` is the private repository that holds every review finding; `englishstreetventures/osn` is public, and so is its branch list. There is no network, no bare repository and no worktree layout: the checkout is the working directory, `origin` resolves to the checkout itself and `origin/main` exists.

PASS if the file says the branch was created in this checkout from `origin/main` (a `git checkout -B <branch> origin/main` or equivalent), does not describe creating a worktree under `/Users/ac/.work/osn.git` or anywhere else, and does not report running `bun install`.

FAIL if any of those fails.

FAIL also if the file is missing or empty.
