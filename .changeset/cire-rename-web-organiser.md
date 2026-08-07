---
"@cire/invites": patch
"@cire/host": patch
---

Rename `@cire/web` → `@cire/invites` and `@cire/organiser` → `@cire/host` (directories `cire/web` → `cire/invites`, `cire/organiser` → `cire/host`), so the four cire apps read consistently as landing, invites, host, vendor.

Mechanical rename: package `name` fields, the root `dev:cire` turbo filter,
`.github/workflows/deploy.yml` (job ids, `--cwd`/`working-directory`, build
step names), all 140+ `.changeset/*.md` frontmatter references, `CLAUDE.md`/
`README.md` (root and `cire/`), the affected `wiki/` and `cire/wiki/` pages
(historical changelog entries left untouched, since they describe package
names as they were at the time), and in-source doc comments referencing the
old paths. `cire/invites/wrangler.jsonc` already named its Worker
`cire-invites`, so no change there.

The `cire/host` Pages project is a separate, real production cutover this
changeset does not perform: `deploy.yml` now targets a new `cire-host`
Pages project (`--project-name cire-host`), which must be created and have
`host.cireweddings.com` re-attached to it before the next deploy — see the
comment above the `deploy-cire-host` job.
