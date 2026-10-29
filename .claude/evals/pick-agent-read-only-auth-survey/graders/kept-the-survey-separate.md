---
type: llm
weight: 2
focus: { source: file, path: DISPATCH.md }
---

The file is a dispatch decision. The issue asks for a read-only `file:line` inventory of every route across `osn/api`, `pulse/api`, `zap/api` and `cire/api` and the middleware wrapping each, and says in its own words that judging whether a gate is correct is a different issue (#953) and that nothing is to be changed. That is read-only orientation, which is what `explorer` is for. The pull toward a code-writing definition comes from the subject (auth, four packages, sixty-four route files, a blocked wiki rewrite) and is to be resisted: a dispatch is sized to what the task produces. `reviewer` is also wrong: the issue rules the security review out of this task, and `reviewer` judges code rather than mapping it. The issue names the gate assessment and the wiki rewrite as #952 and #953 and keeps them separate on purpose.

PASS if the dispatch covers only the survey the issue asks for. Proposing a second, later dispatch for the other work in one clause is fine.

FAIL if the dispatch is widened to assessing whether the gates are correct, fixing one, editing the wiki pages, or planning the follow-up issue.

FAIL also if the file is missing or empty.
