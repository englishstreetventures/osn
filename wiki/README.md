---
title: "Wiki README"
tags: [meta]
related: [[index]]
last-reviewed: 2026-05-05
---

# Cire Wiki

This directory is an [Obsidian](https://obsidian.md) knowledge graph for the Cire project.

## Opening in Obsidian

1. Open Obsidian → "Open folder as vault" → select this `wiki/` directory.
2. Obsidian will create a `.obsidian/` settings folder (gitignored).

### Recommended settings

| Setting             | Value                                |
| ------------------- | ------------------------------------ |
| Use `[[Wikilinks]]` | ON                                   |
| New link format     | Shortest path when possible          |
| Show frontmatter    | ON (or install Dataview for queries) |

## AI Agent Guide

1. Start at `CLAUDE.md` in the repo root — it contains conventions and commands.
2. Follow `[[wiki links]]` to navigate between pages.
3. Check frontmatter on every page: `tags`, `related`, and `status` fields tell you what the page covers and what it connects to.
4. When creating or modifying wiki pages, always update `last-reviewed` in frontmatter.

## Querying Without Obsidian

You don't need Obsidian to browse the wiki. Use grep/ripgrep:

```bash
# Find all pages tagged "security"
rg "tags:.*security" wiki/

# Find all pages that link to a specific page
rg "\[\[contributing\]\]" wiki/

# List all TODO items across the wiki
rg "- \[ \]" wiki/

# Find pages by title
rg "^title:" wiki/ --glob "*.md"
```

For richer queries, install [obsidian-cli](https://github.com/obsidian-cli/obsidian-cli).

## Conventions

- All internal links use `[[wiki links]]` syntax.
- Every page has YAML frontmatter with at least `title`, `tags`, `related`, `last-reviewed`.
- Every page links to at least 2 other pages.
- `.obsidian/` is gitignored — vault settings are personal.
