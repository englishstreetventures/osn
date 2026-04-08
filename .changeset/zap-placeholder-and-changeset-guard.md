---
---

Create the `zap/` top-level directory as a placeholder for the messaging
app. No workspaces scaffolded yet — just a `zap/README.md`, the
`zap/*` workspaces glob in the root `package.json`, and a multi-phase
build plan in `TODO.md` (M0 scaffold → M1 1:1 DMs → M2 groups → M3
organisation chats → M4 locality channels → M5 polish + AI view).

Also harden the changeset workflow so a typo in a `.changeset/*.md`
package reference fails the PR instead of the post-merge release run:

- Fix `fix-handle-regex-error-message.md`, which referenced a
  non-existent `pulse` package and broke the previous Release run on
  main. The fix is in `@osn/ui/src/auth/Register.tsx`, so the changeset
  now correctly bumps `@osn/ui`.
- The Changeset Check workflow now installs deps and runs
  `bunx changeset status`, which exits non-zero when any changeset
  references a package that is not in the workspace. This catches the
  same class of typo at PR-review time, before it can poison main.
- `CLAUDE.md` documents the rule explicitly: changeset package names
  must match a workspace `name` field exactly (e.g. `@pulse/app`, not
  `pulse`).

Docs touched: `README.md` (Zap section + monorepo tree), `CLAUDE.md`
(Quick Context, Current State table + tree, Conventions), `TODO.md`
(Up Next, new Zap section, Deferred Decisions, Infrastructure).
