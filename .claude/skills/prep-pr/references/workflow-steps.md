# The steps that need a repository, a network, or a person

These four are lifted out of `SKILL.md` to hold it under the token budget a
skill is read at. Each is a real part of preparing a pull request; none can run
in a sandbox with no network, no package manager and nobody to answer a
question, which is where this skill is measured.

**Open this file when you reach the step, if its prerequisites are actually
available.** If they are not, the rule in `SKILL.md` still applies: do the
step's static equivalent, write the verdict into the report, and move on.

## Step 3 — Commit uncommitted changes

Run `git status --porcelain`.

If any uncommitted changes exist, group them into logical commits rather than staging everything at once:

1. Show the full list of changed/untracked files to the user.
2. Analyse the files and propose a grouping into logical commits — e.g. schema changes together, route changes together, frontend changes together, config/tooling separately. Each group should represent one coherent unit of work.
3. Present the proposed groupings and commit messages to the user and ask them to confirm, adjust, or add files to a group.
4. Once confirmed, stage and commit each group in order.

If the user prefers to set the work aside instead, make a WIP commit. Never run bare `git stash`/`git stash pop` — the stash stack is shared with every other worktree of this repo, so a pop can take someone else's work.

If you were told not to commit, or there is no user to confirm a grouping, leave the tree as it is, record the uncommitted files in the report, and continue. Your own report and PR-body files are expected to be uncommitted and are never grouped into a commit.

---

## Step 5 — Check for unrelated changes

Review the changed workspaces list. If changes span multiple clearly unrelated domains (e.g. backend package changes mixed with an unrelated frontend feature, or infra changes bundled with feature work), present the concern to the user:

"These workspaces appear unrelated: [list]. Would you like to isolate any of them into a separate PR before pushing?"

Proceed when the user confirms the scope is intentional or agrees to split the work.

---

### Findings fixed on this branch

Do not open an issue and close it. Do not edit a checkbox. Put `Closes #N` in the PR body (Step 8) and let the merge close it.

If the finding predates this branch it already has an issue — find it by ID, since the ID leads the title:

```bash
gh issue list --repo xchromo/osn-tracker --search "S-M1 in:title" --state open
```

If a fixed finding turns out to have no issue, open one and close it with a comment naming the PR. **Never delete an issue** — `wiki/conventions/review-findings.md` keeps the history.

### Planned work completed by this branch

Find its issue in the public repo and add it to the `Closes #N` list in Step 8. Same rule: no checkbox edits, no deletions.

```bash
gh issue list --repo xchromo/osn --search "<keywords>" --state open
```

### Up Next

No longer a file to prune. Move the issue's **Status** field in the **OSN Platform** project — `Done` is set by the merge, so the only manual move here is promoting what this branch unblocked. Surface 2–3 candidates to the user and let them decide; do not move anything unasked.

### Docs

**Invoke `obsidian:obsidian-markdown` before writing any page under `wiki/`.** It is the syntax authority for this vault — wikilinks, callouts, embeds, properties, block IDs. Two constraints on top of it, both in the "Writing to the wiki" section of `CLAUDE.md`: edit with **Edit/Write in this worktree** (the Obsidian MCP and the `obsidian` CLI both write to `main`'s tree, so they search and nothing more), and keep anything a GitHub reader needs in tables and mermaid, which render on both surfaces.

Two things to check, both in the same PR as the code:

- **`CLAUDE.md`** — only if this branch adds a pattern, package, convention or architectural decision a future session needs. Reusable context, not noise.
- **The wiki page for every system this branch changes.** A modified system means an updated page; a new one means a new page, linked from at least two existing pages plus the CLAUDE.md navigation table and `wiki/index.md`. `CLAUDE.md` §Wiki maintenance rules holds the frontmatter and linking requirements — follow them there rather than repeating them here.

**Then check the links you just wrote resolve.** `mcp__obsidian-wiki__find_broken_links` indexes `main` and cannot see this branch, so check locally — the `comm -23` recipe is in `reference/wikilink-check.md`.

Commit any doc updates with the message: `docs: update wiki for <branch-summary>`.

Report the issues opened and the issue numbers this branch closes — Step 8 needs both.

---

## Step 9 — Push and open the PR

Run `git push -u origin HEAD`, then open the PR **against `$BASE` from Step 0**, not against `main`:

```bash
gh pr create --base "$BASE" --title "<title>" --body-file <path>
```

`gh pr create` also reads `branch.<current>.gh-merge-base` on its own, so `--base` is belt and braces — pass it anyway, because a branch created without that config silently targets `main`.

Pass `--body-file`, never `--body`: a heredoc inside `--body` mangles backticks and `$` in the prose.

With no network or no `gh`, record that the PR was not opened, name the base it should target, and leave the body file in place. That is a complete run.

### After opening

Confirm the base actually took:

```bash
gh pr list --repo xchromo/osn --state open --json number,headRefName,baseRefName
```

A stacked PR showing `main` in `baseRefName` is not stacked — fix it with `gh pr edit <n> --base <parent-branch>` rather than in the web UI.

### Register the stack

Only when `$BASE` is not `main`. A correct base gives a correct diff; it does not make GitHub render a stack, which is a separate object.

```bash
gh stack link <bottom-pr> [<middle-pr> …] <this-pr>   # bottom to top
gh stack checkout <stack-number>                       # confirm
```

Why `checkout` and not `view` confirms it, and what to do with no network: `reference/registering-a-stack.md`.

Report the PR number, its base branch, whether the stack is registered, and the issues it closes.
