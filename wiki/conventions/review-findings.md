---
title: "Review Findings Format"
tags: [convention, review]
related: [[contributing]], [[TODO]], [[index]]
last-reviewed: 2026-05-05
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

## TODO.md Backlog Rules

Findings flow into the Security Backlog and Performance Backlog sections of [[TODO]]:

1. **Never delete** a finding from the backlog — mark it `[x]` with a fix note when resolved.
2. **Sort by severity** — Critical first, then High, Medium, Low.
3. **Mark `[x]` with fix note** when the fix is merged: `- [x] S-C-1: Unauthenticated organiser endpoint — fixed in feat/organiser-auth`.
4. **Move to changelog** when the fix is released — transfer the resolved item to [[completed-features]], [[security-fixes]], or [[performance-fixes]] as appropriate.
