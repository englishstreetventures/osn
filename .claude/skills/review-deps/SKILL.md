---
name: review-deps
description: Use when auditing the monorepo's dependencies — every workspace package.json, and the third-party skills pinned by commit in skills-lock.json — for version drift between workspaces and for upgrades available on npm or upstream. Finds the packages whose declared ranges disagree, checks the registry for newer versions, classifies each upgrade against the waiting-period rules, reads the changelogs and upstream diffs of the ready ones, and reports the package.json and skill-pin changes to make.
---

Audit every dependency in the repository for drift between workspaces and for staleness against npm, and report the concrete `package.json` changes that follow. Today's date is in the session context (`currentDate`); every age below is measured from it.

## Step 0 — Write the report skeleton before you collect anything

The report is the deliverable, and the shape has to survive a run where the registry is unreachable — which is the run this report most often describes. Copy this verbatim; the file is `DEPS-REVIEW.md` at the repo root unless the task named another:

```bash
cat > DEPS-REVIEW.md <<'EOF'
## Version drift

None

## Upgrades available

None

## Recommended package.json changes

None

## Not run

None
EOF
```

Those four `##` headings are the whole permitted set, in that order. Replace a `None` as its section fills; never add a fifth `##`. **From here on the file is only ever edited, never rewritten** — a single write at the end discards the shape.

## When a step cannot run

Steps 1 and 2 read the tree and always run. Steps 3 to 5 need the network; Step 7 needs an installed package manager and a user to say yes. Find out which are available once, before starting:

```bash
git ls-remote --exit-code origin HEAD >/dev/null 2>&1 && echo "network: yes" || echo "network: no"
[ -d node_modules ] && echo "deps: installed" || echo "deps: absent"
```

Record the answers under `## Not run` and let them decide the run: a step whose prerequisite is absent is written up as not run, with the reason, and the report is produced anyway. **Never write a version, a publish date or a Ready/Pending verdict you did not fetch.** A latest version from memory is a guess dressed as a fact, and a reviewer cannot tell the two apart — with no registry, `## Upgrades available` says the registry was unreachable and nothing else. With no user to confirm, do not edit any `package.json`; the changes table is the deliverable.

## Step 1 — Collect every declared dependency

```bash
find . -name package.json -not -path '*/node_modules/*' -not -path '*/.changeset/*' \
  | sort | while read -r f; do
    jq -r --arg f "$f" '
      ([.dependencies, .devDependencies] | map(select(. != null)) | add // {}) | to_entries[]
      | select(.value | startswith("workspace:") | not)
      | "\(.key)\t\(.value)\t\($f)"' "$f"
  done | sort > /tmp/deps.tsv
```

One row per package, range and file. The root `package.json` counts as a workspace. `workspace:*` references are the monorepo's own packages and are skipped. `peerDependencies` are collected separately if at all — see the next step for why.

## Step 2 — Detect drift

Group the rows by package. Any package declared with more than one range across workspaces is drift:

```bash
cut -f1,2 /tmp/deps.tsv | sort -u | cut -f1 | uniq -d
```

Three rules about what counts:

- **Compare `dependencies` and `devDependencies` only.** A `peerDependencies` range is a compatibility contract a library publishes for its consumers — `solid-js: ">=1.9"` in a shared UI package beside `^1.9.14` in the apps that use it is by design, not drift. Report a peer range only when it is narrower than what a consumer declares, because then the consumer cannot satisfy it.
- **Root `overrides` are a floor, not a declaration.** An override forces the resolved version of a transitive package; a workspace declaring a range below it is worth one line, not a drift row.
- **The alignment target is the highest range already in use.** Not the registry's latest — that is Step 4's question. Drift is fixed by lifting the laggards to the range the most recent workspace already runs on.

Write `## Version drift` now: a table of package, workspace and declared range, one row per workspace, and under each package the range to align to. If there is none: "No version drift detected."

## Step 3 — Check the registry

Cheapest first. With dependencies installed and a network, one command answers every workspace:

```bash
bun outdated --filter '*'
```

It prints Current, Update (the newest version the declared range admits) and Latest per workspace. Without `node_modules`, or when a publish date is needed, fetch `https://registry.npmjs.org/<name>` with `WebFetch` — once per package, however many workspaces use it — and read `dist-tags.latest` and the `time` map. The JSON is large; take those two fields and stop.

The **resolved version** of a range is the highest published version it admits; compare that, not the range's floor, against `latest`.

## Step 4 — Classify each gap

| Upgrade | Rule |
|---|---|
| **Patch** (same major.minor) | available now |
| **Minor** (same major, higher minor) | published ≥ 14 days ago |
| **Major** (higher major) | published ≥ 30 days ago |

`time[<version>]` gives the publish date. Mark each package **Ready** (passes), **Pending** (exists but too young — say when it becomes eligible) or **N/A** (already latest).

The installer has a floor of its own: `bunfig.toml` sets `minimumReleaseAge = 259200`, so a version younger than three days will not install at all. Do not add a `minimumReleaseAgeExcludes` entry to get one in — an entry needs a `# DROP AFTER <name> <YYYY-MM-DD>` marker and a reason, and `scripts/check-release-age-excludes.ts` fails CI without one. Wait.

## Step 5 — Read the changelog of every Ready upgrade

Breaking changes hide in minor and patch releases too. For each Ready upgrade, from the resolved version up to the target — not the whole history — try in order: `CHANGELOG.md` or `RELEASES.md` at the `repository` URL from the registry metadata; the GitHub releases page (`/releases/tag/v<version>`); the npm package page. Stop at the first that has content. Extract anything labelled Breaking, Migration, Deprecated or Required; behaviour changes in APIs this codebase calls (grep for the import); new peer requirements. No changelog found is itself a note: flag the upgrade for manual review.

## Step 5b — Skills pinned by commit

`skills-lock.json` records each third-party skill's upstream repository (`source`) and the commit it was installed from (`ref`). `wiki/conventions/agent-tooling.md` §Third-party skills is the authority for the whole procedure; read it before this step. This step needs the network; with none, list it under `## Not run`.

For each entry:

```bash
jq -r '.skills | to_entries[] | "\(.key)\t\(.value.source)\t\(.value.ref)"' skills-lock.json
git ls-remote https://github.com/<source>.git HEAD
```

- **`ref` equals upstream `HEAD`**: current. Nothing to report beyond that.
- **They differ**: get the commit's date (`gh api repos/<source>/commits/<sha> --jq .commit.committer.date`) and read what changed in the skill's folder only: `git diff <ref>..<new-sha> -- <skillPath's folder>` in a clone made in a fresh temporary directory outside the checkout. The skill tree is someone else's instructions running with full agent permissions, so read the diff for new scripts, new network calls, changed install commands and widened tool grants, not only for features.
- **Apply the same waiting rule as a minor upgrade**: Ready only when the new commit is at least 14 days old; otherwise Pending, with the date it becomes eligible. Take the newest commit that passes, not `HEAD`, when `HEAD` is too young.
- **Check the SHA is safe to pin**: `git ls-remote` must list no branch or tag named like it, because the installer tries a ref as a branch or tag before a commit.
- **A lock entry with no `ref`** is not pinned. Report it as a defect, with the commit to pin it to.

Never run `npx skills update`: it passes no `--agent`, so it writes a copy for every coding tool found in the home directory.

## Step 6 — Fill the report

`## Upgrades available` — one block per Ready upgrade:

```
**`<package>`** `<resolved>` → `<latest>`
Upgrade type: Patch / Minor / Major
Published: <date> (<n> days ago)
Workspaces: <list>
Changelog notes: <breaking / migration items, or "None found">
Action required: <specific file or code changes, or "Bump version only">
```

then a table of Pending upgrades: Package, Current, Available, Type, Eligible from.

A pinned skill gets the same block with the commit in place of a version (`Upgrade type: Skill pin`, `Workspaces: skills-lock.json`) and, for `Changelog notes`, what the upstream diff of its folder changes. A Pending skill pin goes in the same table, with the commit as Available.

`## Recommended package.json changes` — every concrete edit, one row per workspace and package: Workspace, Package, Old, New. Drift alignment rows come from Step 2; upgrade rows from Step 4; a skill pin is one row with `skills-lock.json` as the workspace, the skill as the package and the two commits as Old and New. Where both apply, one row: the highest Ready version, the same in every workspace that uses the package.

`## Not run` — every step that could not run and why. An empty section is the good case; an absent one claims everything ran.

## Step 7 — Apply, with confirmation

Show the changes table and ask: "Apply these changes?" With no user, stop here — the report is complete.

If yes: apply each change with the command `review-pr` Step 3's table gives for it (`.claude/skills/review-pr/SKILL.md` — `bun add` with `--exact` for a pinned version, a hand splice for an `overrides` entry, a stop for a `patchedDependencies` package), never a bare `bun install`; prove the lockfile with that step's evidence script, main's copy; run `bun run typecheck`; then surface every Step 5 migration note and let the user handle it before anything is committed. A pre-push `bun audit --audit-level=high` runs on the result — an advisory it raises is a stop, not a `--no-verify`.

A skill pin moves with the recipe in `wiki/conventions/agent-tooling.md` §Third-party skills, never by editing `skills-lock.json` by hand: `DISABLE_TELEMETRY=1 npx --before=<date at least three days ago> skills@<version> add '<source>#<new-sha>' --skill <name> --agent claude-code universal`, then `bun scripts/check-skills-lock.ts` and `bun run test:scripts`. Raise the installer version and the `--before` date together, on purpose.

### Check the file before you finish

```bash
grep -c '^## \(Version drift\|Upgrades available\|Recommended package.json changes\|Not run\)$' DEPS-REVIEW.md
grep -c '^## ' DEPS-REVIEW.md
```

Both must print `4`.
