---
description: A branch that shortens the guest session cookie's lifetime in the two routes that mint it and edits the wiki page describing the guest auth model alongside — but only some of the page's mentions of the old value, and it renames a heading that two links point at. Tests whether a docs review cross-checks the page's claims against the code on the branch rather than reading the page for internal tidiness, follows a heading rename to the links that break on it, names the pages outside the diff that now carry a stale value, and leaves alone the one link shape that looks broken and is not.
max_turns: 200
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

# Review the documentation on `fix/cire-api-guest-session-ttl`

You are in a checkout of the repository, on the branch `fix/cire-api-guest-session-ttl`. It shortens the lifetime of the guest session cookie in the two routes that mint it, and updates the wiki page that describes the guest auth model alongside the code.

Review the documentation this branch touches, to whatever standard this repository holds its docs to before a branch merges.

## Environment

- There is no network. `git push`, `git fetch` and every `gh` command will fail. That is by design; do not treat it as a defect and do not claim any remote action succeeded.
- Obsidian is not installed and no Obsidian tooling is available. Work from the files on disk.
- Package tooling is not installed. `bun install` and the test runner will fail; read the source from disk instead.
- Do not modify any file other than your report — no wiki edits, no source edits, no commits. Review; don't fix.

## Deliverable

Write your report to `DOCS-REVIEW.md` at the root of the repository. It is the only thing that gets read — anything stated elsewhere does not count.
