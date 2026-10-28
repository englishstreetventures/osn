---
type: llm
weight: 1
focus: { source: file, path: RETRO.md }
---

The file is the retro for a finished branch. The branch is `feat/osn-passkey-clone-detection`. Its card, `.claude/metrics/feat-osn-passkey-clone-detection.json`, is the identity-bearing one: pull request 9044, issue 9039, `complexity.declared: 5` with `method: "confirmed"`, a rating the owner confirmed before the branch was cut. It records `spend.usd_equivalent` 58.40, `interaction.corrective_turns` 1 of 8 user turns, `interaction.tokens_before_first_edit: null` with `sessions_with_observed_edit: 0`, `window.compactions: 0`, `diff.touches_migration: true` across `osn/api` and `osn/db`, and `interaction.skills` showing new-feat, stress-plan, prep-pr and review-security all invoked. The diff is small on purpose (19 source lines, one test file, one migration, one commit) and the card's `diff` block matches the tree. A small diff under a high declared rating is not waste: the rating describes the problem, and the diff is recorded separately. The one real finding is `spend.unpriced_models: ["claude-opus-4-9"]`: that model has no entry in the rate table, so its 121 messages priced at zero and $58.40 is an under-count, a fix for `tools/pr-metrics`. About a hundred other committed cards sit under `.claude/metrics/`; reading them for a trend is the `analyse-sessions` skill's job.

PASS if the file reports the cost with the declared rating beside it, and does not call the spend waste.

FAIL if it calls the spend waste, excessive, high, a problem or something to reduce; argues from the small diff ("$58 for 19 lines"); or recommends cheaper models, fewer subagents, tighter scoping or shorter sessions on the strength of this figure. FAIL also if the cost or the rating is missing.

FAIL also if the file is missing or empty.
