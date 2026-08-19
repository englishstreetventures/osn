---
title: "Cire TODO — a pointer to GitHub Issues"
tags: [todo, pointer]
related:
  - "[[index]]"
  - "[[contributing]]"
  - "[[deferred]]"
  - "[[future]]"
last-reviewed: 2026-08-19
---

# Cire TODO

Cire work is tracked in GitHub Issues under `label:product:cire`. Nothing is tracked here.

| What | Where |
|---|---|
| Guest site, organiser portal, API, schema, platform build-out | [xchromo/osn](https://github.com/xchromo/osn/issues) — public |
| Security, performance and compliance findings | `xchromo/osn-tracker` — private |

```bash
gh issue list --repo xchromo/osn --state open --label product:cire
gh issue list --repo xchromo/osn-tracker --state open --label product:cire
gh issue create --repo xchromo/osn --type Feature --label product:cire --title "..."
```

Every finding goes to the tracker whatever its severity — `xchromo/osn` is public and a
finding names an unpatched route. Full label and type rules are in the root `CLAUDE.md`.

## Where the shards went

The per-area shards under `wiki/todo/` — `status`, `web`, `api`, `db`,
`spreadsheet-import`, `security`, `perf`, `platform` — were retired in the 2026-08-15
migration. Every open item in them is an issue; every completed item is a closed
issue.

Two of them were never checklists and survive as pages in their own right:

- [[deferred]] — open architectural decisions, and the log of resolved ones.
- [[future]] — post-MVP ideas, too vague to be issues yet.
