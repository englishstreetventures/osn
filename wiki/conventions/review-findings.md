---
title: Review Finding IDs
description: Tagging system for security, performance, and test review findings
tags: [convention, review]
---

# Review Finding IDs

All review skills (`/review-security`, `/review-performance`, `/review-tests`) tag findings with short IDs so they can be referenced precisely in discussions, PR comments, and TODO.md backlogs.

## Prefix Table

| Prefix | Skill | Tier |
|--------|-------|------|
| `S-C` | review-security | Critical |
| `S-H` | review-security | High |
| `S-M` | review-security | Medium |
| `S-L` | review-security | Low |
| `P-C` | review-performance | Critical |
| `P-W` | review-performance | Warning |
| `P-I` | review-performance | Info |
| `T-M` | review-tests | Missing file |
| `T-U` | review-tests | Untested export |
| `T-E` | review-tests | Error path |
| `T-R` | review-tests | Route test |
| `T-S` | review-tests | Suggestion |

## Numbering

Counters increment within each tier across the full report. For example, a security review might produce:

- `S-H1` -- first high-severity finding
- `S-H2` -- second high-severity finding
- `S-M1` -- first medium-severity finding
- `S-M2` -- second medium-severity finding
- `S-L1` -- first low-severity finding

## Finding Format

Each finding uses a four-field format:

| Field | Purpose |
|-------|---------|
| **Issue** | What is wrong or missing |
| **Why** | Why this matters (risk, impact) |
| **Solution** | Concrete fix or mitigation |
| **Rationale** | Why this solution is the right approach |

## Adding to TODO.md

When adding findings to the Security or Performance backlogs in TODO.md, use the finding ID as the item label:

```markdown
- [ ] S-M3 -- No rate limit on /foo endpoint
- [x] P-W1 -- N+1 in listEvents (fixed: inArray batch fetch)
- [ ] S-H12 -- New route bypassing loadVisibleEvent
- [x] S-L20 -- Environment not classified correctly (fixed: added env validation)
```

Rules:

- Mark completed items with `[x]` plus a short note about the fix
- **Never delete** findings from the backlog -- the history matters
- Sort within each section by severity (H -> M -> L for security, C -> W -> I for performance)
- Add new findings from PR reviews immediately

## Usage in PR Comments

Finding IDs make PR discussions precise:

- "Fix S-H1 before merging"
- "P-C2 still open -- needs the batch query"
- "S-M34 is a known limitation, tracked in TODO.md"
- "T-U3 -- this export has no test coverage"

## Related

- [[contributing]] -- PR workflow and conventions
- TODO.md -- where findings are tracked in the Security and Performance backlogs
