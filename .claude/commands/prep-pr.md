Prepare the current branch for a pull request. Run the following steps in order.

---

## Step 1 — Identify changed workspaces

Run `git diff --name-only main...HEAD` to list all changed files.

Map changed files to workspaces using these rules:
- Files under `apps/<name>/` → workspace `apps/<name>`, package `@osn/<name>`
- Files under `packages/<name>/` → workspace `packages/<name>`, package `@osn/<name>`
- Files touching only root config (`.claude/`, `turbo.json`, `lefthook.yml`, root `package.json`, `.changeset/`, `.github/`) are **CI/infra-only** — note this separately; they do not require a named package entry in the changeset.

Report: the list of affected workspaces and whether any CI/infra-only files were changed.

---

## Step 2 — Check changesets

Run `git diff --name-only main...HEAD -- .changeset/` and filter out `config.json` and `README.md` to find new changeset files on this branch.

**If no new changeset files exist:**
- Summarise the changes (from the step 1 diff) in 1–2 sentences suitable for a changeset summary.
- Present this summary to the user and ask them to confirm or edit it.
- If all changes are CI/infra-only (no workspace packages affected), run: `bun run changeset --empty`
- Otherwise, run `bun run changeset` — the interactive CLI will prompt for packages and bump type; guide the user to select the affected packages and an appropriate bump type (patch for fixes, minor for features, major for breaking changes).

**If changeset(s) exist:**
- Read each new changeset file and extract the package names listed in its YAML frontmatter (between the `---` fences).
- Compare against the affected workspace packages from step 1.
- If any affected package is missing from all changesets, warn the user and offer to run `bun run changeset` to add coverage.

---

## Step 3 — Commit uncommitted changes

Run `git status --porcelain`.

If any uncommitted changes exist, group them into logical commits rather than staging everything at once:

1. Show the full list of changed/untracked files to the user.
2. Analyse the files and propose a grouping into logical commits — e.g. schema changes together, route changes together, frontend changes together, config/tooling separately. Each group should represent one coherent unit of work.
3. Present the proposed groupings and commit messages to the user and ask them to confirm, adjust, or add files to a group.
4. Once confirmed, stage and commit each group in order.

If the user prefers to stash instead: run `git stash`.

Do not proceed to step 4 until the working tree is clean.

---

## Step 4 — Build, test, and review test surface

Invoke the `review-tests` skill as an Agent subagent, passing the list of affected workspace paths as arguments.

Wait for it to complete. If the build fails or any tests fail, stop and show the errors — do not proceed until they are resolved.

If coverage gaps are reported, present them to the user and ask whether they want to address them before continuing.

---

## Step 5 — Check for unrelated changes

Review the changed workspaces list. If changes span multiple clearly unrelated domains (e.g. backend package changes mixed with an unrelated frontend feature, or infra changes bundled with feature work), present the concern to the user:

"These workspaces appear unrelated: [list]. Would you like to isolate any of them into a separate PR before pushing?"

Proceed when the user confirms the scope is intentional or agrees to split the work.

---

## Step 6 — Parallel reviews

Run the following two agents **in parallel** using the Agent tool:

**Agent 1 — Performance review** (general-purpose agent):
Read the file `.claude/commands/review-performance.md` and execute its instructions, passing the list of affected workspaces and the branch name as context.

**Agent 2 — Security review** (general-purpose agent):
Read the file `.claude/commands/review-security.md` and execute its instructions, passing the list of affected workspaces and the branch name as context.

Wait for both agents to complete. Present both reports to the user in full.

Ask the user: "Do you want to address any findings before pushing?" If yes, pause and let the user make changes, then re-run steps 3 and 4 before continuing.

---

## Step 7 — Push and open PR

Run `git push -u origin HEAD`.

Then open the PR using `gh pr create`. Derive the title and body from the branch's commit history (`git log main...HEAD --oneline`):

- **Title**: short imperative summary of the overall change (under 70 chars)
- **Body**: use this structure:

```
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
- <bullet points summarising what changed and why>

## Workspaces affected
- <list of affected packages/apps, or "CI/infra only">

## Test plan
- <checklist of what to verify when reviewing>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Report the PR URL once created.
