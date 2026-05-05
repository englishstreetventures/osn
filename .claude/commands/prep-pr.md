Prepare the current branch for pushing. Run the following steps in order.

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

## Step 2 — Update wiki/TODO.md

Read `wiki/TODO.md` and check off any items the current branch completes:

- Tick `- [ ]` → `- [x]` for items the diff (`git diff --name-only main...HEAD` plus working-tree changes) directly satisfies.
- Audit other sections too — branches often complete items beyond the originating ticket (e.g. a security-backlog or performance-backlog entry, an "Up Next" item).
- If the branch resolves a row in the **Deferred Decisions** table, remove the row and capture the decision in the relevant section / wiki page.
- If the branch makes any TODO item obsolete (no longer relevant, superseded by a different approach), strike it through with a one-line note rather than deleting silently.
- Update the **Current Status** paragraph if the branch shifts what's built or what the next slice is.
- Update the wiki page `last-reviewed` to today's date.

Stage `wiki/TODO.md` (and any wiki page touched) so the check-off lands in the same commits as the feature work.

---

## Step 3 — Commit uncommitted changes

Run `git status --porcelain`.

If uncommitted changes exist:

1. Show changed/untracked files.
2. Propose logical commit groupings (e.g. schema changes, route handlers, frontend components, config). Group `wiki/TODO.md` updates with the commit they describe — never as a trailing "update TODO" commit.
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
