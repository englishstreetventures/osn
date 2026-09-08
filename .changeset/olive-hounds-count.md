---
"@tools/pr-metrics": patch
---

Count skills invoked as slash commands, not only through the `Skill` tool.

A skill run as `/name` produces no `Skill` tool call. It arrives as a user record opening with `<command-name>`, which `humanTurnText` rejects as machinery — correctly, since the record is an envelope rather than a typed instruction — so the invocation was never counted. `skillCommandsIn` reads the envelope, behind a deny-list of the CLI's own commands: `/compact` alone outnumbers every skill invocation in these transcripts combined, and it already means something as `window.compactions`.

Both routes are real invocations, so a skill used each way counts twice. That is the opposite of the queued-prompt case, where two records are one instruction and get collapsed.

Worth stating because it was the reason for the change: this closes an undercount, it does not overturn the finding. Re-running the backfill over 34 merged pull requests moves the total from 5 recorded invocations to 6. Skill usage really is as low as the cards said.
