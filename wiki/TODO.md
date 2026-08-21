---
title: "TODO — a pointer to GitHub Issues"
tags: [todo, pointer]
related:
  - "[[index]]"
  - "[[github-issues-setup]]"
  - "[[review-findings]]"
  - "[[deferred-decisions]]"
last-reviewed: 2026-08-21
---

# OSN Project TODO

Work is tracked in GitHub Issues. Nothing is tracked here.

| What | Where |
|---|---|
| Product work, ops, docs, schema | [xchromo/osn issues](https://github.com/xchromo/osn/issues) — public |
| Security, performance and compliance findings | `xchromo/osn-tracker` — private |
| Board, by product and by type | the **OSN Platform** project |

```bash
gh issue list --repo xchromo/osn --state open --label product:pulse
gh issue list --repo xchromo/osn --state open --label product:cire
gh issue list --repo xchromo/osn-tracker --state open --label severity:high
```

Every issue carries one `product:` label and an issue type — `Feature`, `Bug` or `Task`.
Findings also carry a `severity:`. Route by kind, never by severity: an `S-`, `P-` or `C-`
ID goes to the tracker however minor it looks, because `xchromo/osn` is public and a
finding names an unpatched route.

## Where the old checklists went

- **Completed items** — closed issues. `gh issue list --state closed` in either repo.
- **Open items** — issues, one per item, with the epic as the parent.
- **Deferred decisions** — [[deferred-decisions]]. Open questions are not tracked work.
  Cire's own `deferred` and `future` shards folded in there on 2026-08-21, when the
  cire vault merged into this one.

For how a finding is filed see [conventions/review-findings.md](conventions/review-findings.md).
For the migration and the label set see [runbooks/github-issues-setup.md](runbooks/github-issues-setup.md).
