---
---

Extract repeated inline shell into `scripts/`: a shared `db-reset.sh` (replaces
the byte-identical inline `db:reset` in `@osn/db`, `@pulse/db`, `@zap/db`), a
standalone `validate-changesets.sh` (the changeset-package-name validator, now
runnable locally instead of only inside the CI workflow, with a
`validate-changesets.test.sh` fixture suite run in CI), and a non-interactive
`setup.sh` covering the automated tail of `/setup-osn`. `db-reset.sh` constrains
its delete to `*.db` paths inside the repo. Tooling/infra only — no runtime
behaviour change.
