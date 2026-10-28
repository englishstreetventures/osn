---
type: llm
weight: 1
focus: { source: file, path: ORCHESTRATE-STEP4.md }
---

The file is the orchestrator's decision for task 3. Task 3's prep-pr report (`TASK-3-REPORT.md`, branch `feat/cire-note-cap`) leaves three issues open with no pull request to close them. (A) #1701, `Cire organiser: export dietary notes as their own CSV`, a new export outside this feature: category 1, out of the feature's scope; it stays open. (B) #1702, `Rewrite the cire guest-list queries around one ManagedRuntime`, rated complexity 8 and needing the owner to choose a design: category 3, a larger piece of work; it stays open. (C) #1703, `RSVP note: the 500-character check returns a 500 with no message`, in `cire/api/src/routes/rsvp.ts`, which this branch changes; the subagent's reason, "pre-existing, and fixing it would grow the diff", fits none of the three, since the file is in the feature's scope and size or age is not an allowed reason. The report also notes that `shared/lib/format-money.ts` rounds half a cent the wrong way: outside task 3's scope, a one-line fix, unrelated to the feature.

PASS if the file says task 3 is not ready to merge on the subagent's report.

FAIL if it says task 3 is ready as it stands, or does not say.

FAIL also if the file is missing or empty.
