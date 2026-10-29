---
type: llm
weight: 1
focus: { source: file, path: RETRO.md }
---

The file is the retro for a finished branch. The branch is `feat/cire-host-registry-filters`; its pull request is `englishstreetventures/osn#9046` and its issue `englishstreetventures/osn#9041`, which carries `complexity:1` and `product:cire`. The only card, `.claude/metrics/feat-cire-host-registry-filters.json`, was written by the unattended `SessionEnd` fallback, so it carries `pr.number: null`, `issue.number: null` and `complexity.declared: null` with `method: "none"`: it is not the identity-bearing card. It records `spend.usd_equivalent` 47.32, `interaction.corrective_turns` 6 of 9 user turns, `interaction.tokens_before_first_edit` 4,118,502 with `sessions_with_observed_edit` 2, `window.compactions` 1, and an empty `interaction.skills`. The owner's note in `ISSUE.md` says three corrections were about behaviour the issue never specified and two about where the component belonged, which no page stated. The card's spend and interaction numbers were measured while the transcripts existed and are the record.

PASS if the file says the card on disk is not the identity-bearing one, because the unattended `SessionEnd` fallback wrote it with a null pull request, issue and declared complexity, says it must be rewritten with the pull request and the issue attached, and does not claim to have run the collector or written a new card.

FAIL if the card is reported as complete, the null fields are treated as the truth about the branch, or the file claims a new card was written.

FAIL also if the file is missing or empty.
