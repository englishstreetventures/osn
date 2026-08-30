---
"@tools/oxlint-house": patch
---

Close the gaps in the guards around the dependency and vendored-plugin surface. No rule changes; this is the wiring that decides whether the guards run at all.

- `scripts/verify-vendored-anti-slop.sh` now takes an optional base ref. With none — lefthook's pre-commit hook, and the CI steps ahead of `bun install` — it only proves the tree matches its own `SHA256SUMS`, same as before. With one — CI's `script-tests` job, on pull requests, passed the PR's base SHA — it also fails a change to `tools/oxlint/anti-slop` that does not move the pinned upstream commit in that directory's `README.md`. The checksum half is a self-certification: regenerate the manifest after an edit and it certifies whatever the tree now holds. The pin half is what that manifest cannot do, and it lives in the same script because it guards the same tree.
- `.github/CODEOWNERS` now covers the paths a change could route around a guard through: `bun.lock`, `.bun-version`, every workspace `package.json`, `bunfig.toml` at any depth, and the five `wrangler.toml`/`wrangler.jsonc` files that name production routes and bindings.
- `.github/workflows/ci.yml` declares `permissions: contents: read`. Nothing in it writes an issue, a comment or a package, and the default token is write-all on this repository.
- `check:release-age-excludes` runs in `lefthook.yml` on pre-push, not only in CI, and it now also refuses a second `bunfig.toml` below the repository root. Bun reads the file nearest the working directory, and several scripts run with `--cwd`, so a second one would set the install policy for those runs while the guard went on passing against the root file.
- The re-vendor recipe in `tools/oxlint/anti-slop/README.md` generates the manifest with `find . ! -type d` rather than `-type f`, so it agrees with the checker's `git ls-files` on what counts as a file. A vendored symlink used to read as a spurious diff.
