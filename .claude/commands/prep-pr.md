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

## Step 7 — File the findings as issues

Work is tracked in GitHub Issues, not in a markdown checklist. Two repos:

| Kind of item                          | Repo                                |
| ------------------------------------- | ----------------------------------- |
| Review findings — `S-*`, `P-*`, `C-*` | **`xchromo/osn-tracker`** (private) |
| Planned work, features, bugs          | **`xchromo/osn`** (public)          |

`xchromo/osn` is public. A finding names an unpatched route, so filing one there publishes it. **Route by kind, not by severity** — an `S-`, `P-`, or `C-` ID always goes to the tracker, however minor it looks.

### New findings from Step 6

One issue per finding that this branch does **not** fix. Title leads with the finding ID; body keeps the same four fields the PR uses.

```bash
gh issue create --repo xchromo/osn-tracker \
  --title "S-M1 — No rate limit on POST /events/:id/rsvp" \
  --type Bug \
  --label "area:security" --label "severity:medium" --label "product:cire" \
  --body "$(cat <<'EOF'
**Issue:** What the problem is.
**Why:** Risk, correctness, or design concern.
**Solution:** What would fix it.
**Rationale:** Why that is the right fix.

Found reviewing `<branch-name>`.
EOF
)"
```

Labels, exactly one of each:

- `area:` — `security` for `S-*`, `performance` for `P-*`, `compliance` for `C-*`
- `severity:` — from the ID prefix per `wiki/conventions/review-findings.md`: `C` → `critical`, `H`/`W` → `high`, `M` → `medium`, `L` → `low`, `I` → `info`
- `product:` — `osn-core`, `pulse`, `cire`, `zap`, `shared`, or `landing`

`--type`, exactly one — an org-level field the Project groups and filters on, separate from the labels:

- **`Bug`** for an `S-*` or `P-*` finding: something behaves wrongly and wants fixing
- **`Task`** for a `C-*` compliance item, and for any finding filed at `severity:info` — it records an observation and asks for no fix

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

**Always check and update as needed:**

- **`CLAUDE.md`**: update if this branch introduces a new pattern, package, convention, or architectural decision that future AI sessions need to know about. Do not add noise — only update if the change is genuinely reusable context.
- **`wiki/` pages**: if this branch introduces, modifies, or removes a system, pattern, or convention that has a corresponding wiki page, update that page:
  - **New system/pattern** → create a wiki page with YAML frontmatter (title, tags, related, packages, last-reviewed). Link from ≥2 existing pages. Add to the CLAUDE.md Wiki Navigation table and `wiki/index.md`.
  - **Modified system** → update the corresponding wiki page to reflect the changes.
  - **Update `last-reviewed`** in frontmatter of any wiki page you touch.

The narrative wiki stays hand-written and stays in the repo. Only the checklists moved to issues.

**Then check the links you just wrote resolve.** A new page whose `related` points at nothing, or a `[[wikilink]]` with a typo, is invisible until someone clicks it. `mcp__obsidian-wiki__find_broken_links` is the right tool but the wrong tree — it indexes `main`, so it cannot see this branch's pages at all. Check locally instead:

```bash
# every wikilink target on the branch, minus every page that exists
# both sides reduced to a bare page name, since links come in both
# `[[arc-tokens]]` and `[[systems/arc-tokens]]` form
comm -23 \
  <(git diff origin/main...HEAD --name-only -- 'wiki/**/*.md' \
      | xargs -r grep -oh '\[\[[^]|#]*' | sed 's/^\[\[//; s#.*/##' | sort -u) \
  <(find wiki -name '*.md' | xargs -n1 basename | sed 's/\.md$//' | sort -u)
```

Every line of output is a link that resolves to nothing — fix it or drop it. Two things that look like breaks and aren't: a TOML array header inside a fenced code block (`[[env.<name>.d1_databases]]`) has the same shape as a wikilink and gets picked up, and a link ending in a stray `\` is a typo in the source, not a missing page. Run `find_broken_links` / `find_orphaned_notes` over the MCP **after** the PR merges, when `main` has caught up, to sweep the rot this branch didn't cause.

Commit any doc updates with the message: `docs: update wiki for <branch-summary>`.

Report the issues opened and the issue numbers this branch closes — Step 8 needs both.

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

## Issues

Closes #<n> — <one-line title>
Closes xchromo/osn-tracker#<n> — <finding ID only>

Opened:
- xchromo/osn#<n> — <title>
- xchromo/osn-tracker#<n> — <finding ID only, no description>

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

**The "Issues" section is mandatory.** It lists every issue this branch closes and every issue Step 7 opened. If the branch closes nothing and opened nothing, say "None" — an absent section reads as a forgotten one.

**A PR on `xchromo/osn` is public.** Reference a tracker issue by number and finding ID only — never paste its title, its file:line, or a word of its body. `xchromo/osn-tracker#412 — S-M1` is the whole entry.

A same-repo issue closes on merge with plain `Closes #<n>`. A tracker issue needs the full `Closes xchromo/osn-tracker#<n>`; that works across repos when you have write access to both, so verify it actually closed after the merge and close it by hand if not.

**The "Decisions & issues" section is mandatory.** Every entry must use the four-field format above. Entries that were dismissed rather than fixed must still appear — include the rationale for dismissal in the Rationale field.

Report the PR URL once created.
