---
type: llm
weight: 0.5
focus: { source: file, path: DISPATCH.md }
---

The file is a dispatch decision. The issue asks for a read-only `file:line` inventory of every route across `osn/api`, `pulse/api`, `zap/api` and `cire/api` and the middleware wrapping each, and says in its own words that judging whether a gate is correct is a different issue (#953) and that nothing is to be changed. That is read-only orientation, which is what `explorer` is for. The pull toward a code-writing definition comes from the subject (auth, four packages, sixty-four route files, a blocked wiki rewrite) and is to be resisted: a dispatch is sized to what the task produces. `reviewer` is also wrong: the issue rules the security review out of this task, and `reviewer` judges code rather than mapping it.

PASS if the file does not do the task it is choosing an agent for: no route inventory, no list of middleware per route, no `file:line` findings from the four APIs. Naming one file as an example of where routes live is fine.

FAIL if the file produces any part of the inventory.

FAIL also if the file is missing or empty.
