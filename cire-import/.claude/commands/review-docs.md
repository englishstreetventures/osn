Audit project documentation for currency and completeness. $ARGUMENTS may contain specific paths; if not, audit all docs.

---

## Step 1 — Wiki pages

For each file in wiki/:

- Verify YAML frontmatter has: title, tags, related, last-reviewed
- Flag pages with last-reviewed older than 90 days
- Check for broken [[wiki links]] (target page doesn't exist)
- Flag orphan pages (not linked from wiki/index.md)

---

## Step 2 — CLAUDE.md

- Verify patterns section matches actual code (spot-check key patterns against source)
- Verify commands section lists correct commands
- Verify wiki navigation table links to existing pages

---

## Step 3 — README.md

- Verify architecture description matches actual directory structure
- Verify tech stack table matches actual dependencies

---

## Step 4 — wiki/TODO.md

- Flag completed items still in "Up Next" (should move to changelog)
- Verify security/perf backlog items reference valid finding IDs

---

## Report

- **Stale** — pages not reviewed in >90 days
- **Broken link** — [[wiki link]] target doesn't exist
- **Orphan** — page not linked from index
- **Drift** — doc content doesn't match current code
- **Missing frontmatter** — required fields absent

If no issues found, state: "Documentation is current."
