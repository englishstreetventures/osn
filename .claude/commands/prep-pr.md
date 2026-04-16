Prepare the current branch for a pull request. Run the following steps in order.

---

## Step 1 — Identify changed workspaces

Run `git diff --name-only main...HEAD` to list all changed files.

Map changed files to workspaces using these rules:
- Files under `osn/<name>/` → workspace `osn/<name>`, package `@osn/<name>` (except the special case: `osn/db` → `@osn/db`, `osn/api` → `@osn/api`)
- Files under `pulse/<name>/` → workspace `pulse/<name>`, package `@pulse/<name>`
- Files under `shared/<name>/` → workspace `shared/<name>`, package `@shared/<name>`
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
- **Validate every package name** against the actual `name` field in its `package.json`. Run `jq -r .name <workspace>/package.json` for each. A mismatch (e.g. `osn` instead of `@osn/api`, or `@osn/app` instead of `@osn/api`) will cause `changeset version` to fail in CI with "package not in workspace". Fix any mismatches before continuing.
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

Wait for both agents to complete. Present both reports to the user in full, using the finding IDs from each review (e.g. S-H1, P-W2) so they can be referenced in the PR description.

Ask the user: "Do you want to address any findings before pushing?" If yes, pause and let the user make changes, then re-run steps 3 and 4 before continuing.

---

## Step 7 — Update documentation

Before pushing, update the relevant docs to reflect the changes made on this branch.

**Always check and update as needed:**

- **`wiki/TODO.md` — Security/Performance backlogs**: add any new `S-*` / `P-*` findings from Step 6. Use the finding ID as the item label (e.g. `- [ ] S-M1 — No rate limit on /foo endpoint`). Include `[[wiki links]]` to affected system pages (e.g., `[[rate-limiting]]`, `[[arc-tokens]]`). Mark findings resolved on this branch with `[x]` + short note.
- **`wiki/TODO.md` — App/Platform sections**: check off items completed by this branch.
- **`wiki/TODO.md` — Up Next**: prune completed items. Review the full TODO and surface 2–3 suggested next priorities to the user — items that are now unblocked, newly urgent, or logically follow from this branch's work. Let the user decide whether to add them.
- **`CLAUDE.md`**: update if this branch introduces a new pattern, package, convention, or architectural decision that future AI sessions need to know about. Do not add noise — only update if the change is genuinely reusable context.
- **`wiki/` pages**: if this branch introduces, modifies, or removes a system, pattern, or convention that has a corresponding wiki page, update that page:
  - **New system/pattern** → create a wiki page with YAML frontmatter (title, tags, related, packages, last-reviewed). Link from ≥2 existing pages. Add to the CLAUDE.md Wiki Navigation table and `wiki/index.md`.
  - **Modified system** → update the corresponding wiki page to reflect the changes.
  - **Update `last-reviewed`** in frontmatter of any wiki page you touch.

Commit any doc updates with the message: `docs: update wiki and TODO for <branch-summary>`.

---

## Step 8 — Push and open PR

Run `git push -u origin HEAD`.

Then open the PR using `gh pr create`. Derive the title and body from the branch's commit history (`git log main...HEAD --oneline`) and everything that happened during this prep-pr run:

- **Title**: short imperative summary of the overall change (under 70 chars)
- **Body**: use this structure:

```
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
- <bullet points summarising what changed and why>

## Workspaces affected
- <list of affected packages/apps, or "CI/infra only">

## Decisions & issues

<For every non-trivial decision, lint/type error, test failure, or security/perf finding — use this format per item:>

**[S-H1 / P-W2 / approach / etc.]** — <short title>
- **Issue:** What the problem was.
- **Why:** Why it mattered — risk, correctness, or design concern.
- **Solution:** What was done to address it.
- **Rationale:** Why this is the right fix.

## Test plan
- <checklist of what to verify when reviewing>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**The "Decisions & issues" section is mandatory.** Every entry must use the four-field format above. Entries that were dismissed rather than fixed must still appear — include the rationale for dismissal in the Rationale field.

Report the PR URL once created.
