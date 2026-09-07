---
"@tools/oxlint-house": patch
---

Add `house/no-tracker-ref-in-comment`, an oxlint rule that flags a comment carrying work-tracking state or a bug's history.

Four shapes, each reported separately with its own message and pointed at the line it sits on rather than the top of the block containing it: an `osn-tracker#` issue number, a review finding tag (`\b[CDPST]-[A-Z]\d+\b`, covering the security, perf, tests, docs and compliance tiers, single- or multi-digit, and matched mid-line so a parenthesised `(S-M1)` or a prefixed `IB-S-L2` is caught), a phase or plan code (`\b[A-Z]\d+:`), and past-tense narration ("used to be", "was reported as"). All four stop resolving once the issue closes or the plan ships, and the code they annotate is then left with a reason nobody can look up — and osn is public, so a comment naming a private tracker finding is a disclosure as well as a dead link.

A bare `#123` is deliberately not matched: that is an ordinary public cross-reference, and flagging it would make the rule fire on healthy "follows the approach in #123" comments. Present-tense "reported as" is likewise left alone — it is ordinary prose ("anything slower is reported as a timeout"), and only the past-tense form reliably marks narration.

The rule ships at `"warn"` rather than `"error"`. `bun run lint` runs oxlint unscoped over the whole tree with no `--deny-warnings`, and it reports 1600 references across 483 files today (1396 finding tags, 101 plan codes, 60 tracker issues, 43 narrations), so `"error"` would fail every pull request's lint job — including the one adding the rule. The cleanup that clears those files raises the severity as its last step.

A reference is reported once per occurrence rather than once per comment, so a line carrying two tags reports twice and a single pass over the warnings clears the file. The phase-code pattern refuses a match preceded by a hyphen, because a finding tag used as a label ends in a colon as well and would otherwise report a second time as a plan code that was never there.

CLAUDE.md gains the Conventions row this rule enforces. The convention was not written down anywhere before, so the rule and its documentation land together.
