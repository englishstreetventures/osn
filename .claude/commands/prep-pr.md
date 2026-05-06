Prepare the current branch for pushing. Run the following steps in order.

---

## Step 0 — Rebase on origin/main

Before anything else, fetch and rebase to keep conflicts shallow:

```bash
git fetch origin
git rebase origin/main
```

If the rebase has conflicts, resolve them and continue (`git rebase --continue`) before any other step. **Do not** run `git rebase --skip` unless the user explicitly says so — skipping a commit silently drops work. If the conflicts look broad or unfamiliar, abort (`git rebase --abort`) and surface the situation to the user instead of guessing.

---

## Step 1 — Identify changed areas

Run `git diff --name-only main...HEAD`.

Map changed files to workspaces:

- Files under `apps/web/` → workspace `apps/web`
- Files under `apps/api/` → workspace `apps/api`
- Files under `packages/db/` → workspace `packages/db`
- Root config files only → CI/infra-only change

Report the affected areas.

---

## Step 2 — Update the relevant `wiki/todo/<area>.md` shard(s)

TODO is sharded under `wiki/todo/` so PRs only edit the shard relevant to their work and never collide on a single file. **Do not edit `wiki/TODO.md`** — it's a thin index; only structural changes (adding a new shard) should touch it.

Pick shards based on the diff:

| If the diff touches…                                   | Edit shard                                     |
| ------------------------------------------------------ | ---------------------------------------------- |
| `apps/web/`                                            | `wiki/todo/web.md`                             |
| `apps/api/` (general feature work)                     | `wiki/todo/api.md`                             |
| `apps/api/` spreadsheet/import code                    | `wiki/todo/spreadsheet-import.md`              |
| `packages/db/`                                         | `wiki/todo/db.md`                              |
| Anything closing a security-backlog finding            | `wiki/todo/security.md`                        |
| Anything closing a perf-backlog finding                | `wiki/todo/perf.md`                            |
| Resolving a deferred decision                          | `wiki/todo/deferred.md` (move row to Resolved) |
| Reframes the project's "current state" or "next slice" | `wiki/todo/status.md`                          |

For each touched shard:

- Tick `- [ ]` → `- [x]` for items the diff directly satisfies.
- Add new entries surfaced by the work (e.g. a follow-up the PR uncovered).
- If the branch makes any TODO item obsolete, strike it through with a one-line note rather than deleting silently.
- Bump that shard's `last-reviewed` to today.
- Only touch `wiki/todo/status.md` if the **Current Status paragraph** or **Up Next priority list** shifts — otherwise the area-specific shard is enough.

Stage the touched shard(s) so the check-off lands in the same commits as the feature work.

---

## Step 3 — Commit uncommitted changes

Run `git status --porcelain`.

If uncommitted changes exist:

1. Show changed/untracked files.
2. Propose logical commit groupings (e.g. schema changes, route handlers, frontend components, config). Group TODO-shard updates with the commit they describe — never as a trailing "update TODO" commit.
3. Present groupings and messages; ask user to confirm.
4. Stage and commit each group in order.

Do not proceed to step 4 until the working tree is clean.

---

## Step 4 — Build and test

Invoke the `review-tests` skill as an Agent subagent, passing the list of affected workspace paths.

Wait for it to complete. If the build fails or any tests fail, stop and show the errors.

If coverage gaps are reported, present them and ask whether the user wants to address them before continuing.

---

## Step 5 — Check for unrelated changes

If changes span multiple clearly unrelated areas, present the concern and ask whether to split into a separate commit or branch.

---

## Step 6 — Parallel reviews

Run the following two agents **in parallel**:

**Agent 1 — Performance review** (general-purpose agent):
Read `.claude/commands/review-performance.md` and execute its instructions, passing the affected areas and branch name.

**Agent 2 — Security review** (general-purpose agent):
Read `.claude/commands/review-security.md` and execute its instructions, passing the affected areas and branch name.

Wait for both. Present both reports. Ask: "Do you want to address any findings before pushing?"

---

## Step 7 — Observability checklist

Check the changed files against wiki/observability/overview:

- Are error paths logged?
- Are any `console.*` calls introduced in backend code (should use structured logger)?
- Is PII present in log output without redaction?

This step is advisory only — present findings but do not block.

---

## Step 8 — Push and open PR

Run `git push -u origin HEAD`, then:

```
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
- <bullet points>

## Workspaces affected
- <list>

## Test plan
- <checklist>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
