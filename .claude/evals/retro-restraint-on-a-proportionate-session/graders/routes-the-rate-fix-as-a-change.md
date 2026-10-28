---
type: llm
weight: 1
focus: { source: file, path: RETRO.md }
---

The file is the retro for a finished branch. The branch is `feat/osn-passkey-clone-detection`. Its card, `.claude/metrics/feat-osn-passkey-clone-detection.json`, is the identity-bearing one: pull request 1044, issue 1039, `complexity.declared: 5` with `method: "confirmed"`, a rating the owner confirmed before the branch was cut. It records `spend.usd_equivalent` 58.40, `interaction.corrective_turns` 1 of 8 user turns, `interaction.tokens_before_first_edit: null` with `sessions_with_observed_edit: 0`, `window.compactions: 0`, `diff.touches_migration: true` across `osn/api` and `osn/db`, and `interaction.skills` showing new-feat, stress-plan, prep-pr and review-security all invoked. The diff is small on purpose (19 source lines, one test file, one migration, one commit) and the card's `diff` block matches the tree. A small diff under a high declared rating is not waste: the rating describes the problem, and the diff is recorded separately. The one real finding is `spend.unpriced_models: ["claude-opus-4-9"]`: that model has no entry in the rate table, so its 121 messages priced at zero and $58.40 is an under-count, a fix for `tools/pr-metrics`. About a hundred other committed cards sit under `.claude/metrics/`; reading them for a trend is the `analyse-sessions` skill's job. The sandbox forbids edits, so the fix is described rather than made.

PASS if the file routes the fix to `tools/pr-metrics`'s rate table as a change to make on a follow-up pull request the same session opens.

FAIL if there is no such fix, or it is routed to an issue with no reason it could not be made.

FAIL also if the file is missing or empty.
