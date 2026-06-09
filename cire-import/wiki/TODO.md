---
title: "Cire TODO — index"
tags: [todo, index]
related:
  - "[[index]]"
  - "[[monorepo-structure]]"
  - "[[overview]]"
  - "[[contributing]]"
last-reviewed: 2026-05-05
---

# Cire TODO

This file is a thin index. **All tracked items live in per-area shards under `wiki/todo/`** so feature PRs only edit the shard relevant to their work and never collide on this file.

## Shards

| Shard                            | What it tracks                                           |
| -------------------------------- | -------------------------------------------------------- |
| [[wiki/todo/status]]             | Current Status paragraph + Up Next priority list         |
| [[wiki/todo/web]]                | `apps/web` frontend feature work                         |
| [[wiki/todo/api]]                | `apps/api` backend feature work                          |
| [[wiki/todo/db]]                 | `packages/db` schema + migrations                        |
| [[wiki/todo/spreadsheet-import]] | Organiser spreadsheet upload (parser + diff + endpoints) |
| [[wiki/todo/security]]           | H/M/L security findings                                  |
| [[wiki/todo/perf]]               | Performance concerns                                     |
| [[wiki/todo/deferred]]           | Open architectural decisions + Resolved log              |
| [[wiki/todo/future]]             | Vague post-MVP ideas                                     |

## How to update

When a feature PR lands, edit **only the shards your diff actually touches**. The `prep-pr` skill picks the right shard automatically — never write to this index file from a feature branch (only structural changes — adding a new shard — should touch this file).

Convention: every shard has YAML frontmatter (`title`, `tags`, `related`, `last-reviewed`). Bump `last-reviewed` to today when you edit a shard.

## CLI helpers

```bash
# All open TODOs across shards
rg "- \[ \]" wiki/todo/

# Items tagged with a topic
rg "tags:.*security" wiki/todo/

# Find which shard mentions a thing
rg "rate-limit" wiki/todo/
```
