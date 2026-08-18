---
title: "Review Findings Format"
tags: [convention, review]
related: [[contributing]], [[TODO]], [[index]]
last-reviewed: 2026-08-17
---

# Review Findings Format

Standard format for documenting security, performance, and test findings across code reviews.

## Severity Prefix Table

### Security (S-)

| Prefix | Meaning                                                   |
| ------ | --------------------------------------------------------- |
| S-C    | Critical — exploitable now, data exposure or auth bypass  |
| S-H    | High — exploitable with effort, or blocks a critical path |
| S-M    | Medium — defense-in-depth gap, not directly exploitable   |
| S-L    | Low — hardening opportunity, best practice                |

### Performance (P-)

| Prefix | Meaning                                                |
| ------ | ------------------------------------------------------ |
| P-C    | Critical — user-visible latency or resource exhaustion |
| P-W    | Warning — will degrade at scale, fix before launch     |
| P-I    | Info — optimisation opportunity, no urgency            |

### Tests (T-)

| Prefix | Meaning                                       |
| ------ | --------------------------------------------- |
| T-M    | Missing — no test exists for this code path   |
| T-U    | Unclear — test exists but intent is ambiguous |
| T-E    | Error — test has a bug or false positive      |
| T-R    | Redundant — test duplicates another           |
| T-S    | Slow — test is unreasonably slow              |

## Four-Field Format

Every finding uses this structure:

```
### [PREFIX-N] Short title

**Issue:** What is wrong or missing.

**Why:** Why this matters (impact, risk, cost).

**Solution:** Concrete fix — code snippet, config change, or architectural suggestion.

**Rationale:** Why this solution over alternatives.
```

## Numbering

- Increment within each tier: S-C-1, S-C-2, S-H-1, S-M-1, etc.
- Never reuse a number, even after a finding is resolved.

## Filing a finding

Findings are issues in the **private** `xchromo/osn-tracker`, never in the public `xchromo/osn` -- a finding names an unpatched route, and route is by *kind*, not by severity.

```bash
gh issue create --repo xchromo/osn-tracker \
  --title "S-M3 -- No rate limit on /api/claim" \
  --type Bug \
  --label "area:security" --label "severity:medium" --label "product:cire"
```

1. **Never delete a finding -- close it.** The history matters, and a closed issue keeps the body, the fix commit and the discussion.
2. The ID leads the title, so the ID is how you find the issue again: `gh issue list --repo xchromo/osn-tracker --search "S-M3 in:title" --state all`.
3. Severity is a label taken from the tier letter, not a sort order in a file: `--label severity:high`.
4. A finding fixed on the branch that found it needs no issue of its own -- put `Closes xchromo/osn-tracker#<n>` in the PR body, or open one and close it with a comment naming the PR.

The full rules, including the label and type table, are in the root wiki's `[[wiki/conventions/review-findings]]`.
