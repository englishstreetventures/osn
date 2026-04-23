---
title: OSN Wiki — vault README
tags: [wiki, meta]
related:
  - "[[index]]"
last-reviewed: 2026-04-23
---

# OSN Wiki

This directory is an [Obsidian](https://obsidian.md/) vault containing the OSN project's knowledge graph.

## Opening in Obsidian

1. Install [Obsidian](https://obsidian.md/)
2. Open Vault → select this `wiki/` directory
3. Navigate via the graph view or start at [[index]]

## Recommended Settings

When you first open the vault, configure these settings in Obsidian:

- **Settings > Files & Links > New link format**: "Shortest path when possible"
- **Settings > Files & Links > Use [[Wikilinks]]**: ON (default)
- **Settings > Editor > Show frontmatter**: ON

## For AI Agents

This wiki is optimized for AI agent consumption. Key navigation patterns:

- Start at `CLAUDE.md` (repo root) for the slim index with a Wiki Navigation table
- Follow `[[wiki links]]` to reach detailed pages — only read the pages you need
- Check `tags` in YAML frontmatter to filter by concern (e.g., `#runbook`, `#system`, `#observability`)
- Check `related` in frontmatter for explicit navigation edges
- Check `status` field: `active` = current, `planned` = not yet built, `deprecated` = avoid

## Conventions

- All internal links use `[[wiki links]]`, not relative markdown links
- Links to source files use standard markdown: `[file.ts](../path/to/file.ts)`
- Every page has YAML frontmatter with at least: `title`, `tags`, `related`, `last-reviewed`
- Every page links to at least 2 other wiki pages
- The `.obsidian/` directory is gitignored — your local workspace state stays local
