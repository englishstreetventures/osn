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
