# Skill evals

`claude plugin eval` runs an agent against a case twice: once with this
repository's plugin loaded (`.claude/`, which holds the skills and the subagent
definitions) and once without it. The case's graders score both arms, and the
gap between them, `Δ`, is what the plugin adds. A skill whose cases score the
same either way is not steering anything.

## Before any run

- **A run bills the owner's Claude plan.** Every case runs three times per arm
  by default, and every `llm` grader adds a judge call.
- **Run only the cases of the one skill that changed**, with `--case`. Never
  run the whole suite.
- **Ask the owner first**, once they confirm the skill's changes are complete.
  An agent never starts a run on its own.
- **Read the scaffolds before `--scaffold`.** A scaffold runs as you, outside
  the sandbox. Read `git diff <last-run-ref> -- '.claude/evals/*/setup.sh'`,
  where `<last-run-ref>` is the commit whose scaffolds you last ran or read,
  and run nothing until every changed line makes sense. A first run reads the
  scaffolds of the selected cases in full.
- Nothing in CI runs these cases. CI does run `scripts/tests/eval-cases.test.ts`,
  which checks every case's shape, because `claude plugin validate` does not
  read the cases.

## Layout

`.claude/.claude-plugin/plugin.json` makes `.claude/` the plugin, so the cases
live in its default eval directory:

```
.claude/
├── .claude-plugin/plugin.json
├── skills/<name>/SKILL.md
├── agents/<name>.md
└── evals/
    ├── <case>/
    │   ├── prompt.md          # frontmatter: description, max_turns, timeout_seconds, allowed_tools; body: the task
    │   ├── case.yaml          # schema_version, name, context.scaffold_script
    │   ├── setup.sh           # the scaffold: builds the fixture repository in the empty workspace
    │   └── graders/<name>.md  # one pass/fail check per file
    └── results/               # written by each run; ignored by git
```

A case's name begins with the name of the skill it measures. That prefix is
the only mapping there is, and it is what `--case` filters on;
`eval-cases.test.ts` fails on a case no skill name prefixes.

## Running one skill's cases

From the repository root, with the grants the table below gives:

```bash
claude plugin eval .claude --case '<skill>-*' --scaffold --allow-tools <grants> --disallow-tools 'Bash(gh:*)'
```

- `--disallow-tools 'Bash(gh:*)'` takes `gh` away from every case but one. The
  cases name fixture issue and pull request numbers (above the real ranges, so
  a call that got through would find nothing), and nothing they test needs the
  real `gh`. The exception is `orchestrate-parked-draft-waits-on-owner`: it
  plants a stand-in `gh` at `.pr/bin/gh` and scores the calls the agent makes
  to it, so that case runs without the flag. Every other `Bash` case also
  carries a `ran-no-gh-write` grader that fails a run that tried an issue or
  pull request write.

- `--scaffold` runs each case's `setup.sh`. Without it every case starts in an
  empty directory and fails.
- `--allow-tools` grants what the cases need beyond the read-only tools, and
  the grant applies to every case in the run. Several prompts say "you have no
  shell", which stays true only when the run grants no `Bash`, so run cases
  with different grants separately. Only `orchestrate` has such a split:

  ```bash
  claude plugin eval .claude --case 'orchestrate-open-issue-tally' --scaffold --allow-tools Write Edit --disallow-tools 'Bash(gh:*)'
  claude plugin eval .claude --case 'orchestrate-parked-*' --scaffold --allow-tools Bash Write Edit
  ```

- Put `.claude` before `--allow-tools`, which takes a list and would read the
  target as one more tool.
- Narrow the glob when skill names share a prefix: `review-security-*`, not
  `review-*`, which also takes `review-pr`, `review-tests` and the rest.
  `retro-*` likewise takes every `retro-v2-*` case: run `retro-v2` with
  `retro-v2-*`, and run `retro` by its longer prefixes, `retro-fallback-*` and
  `retro-restraint-*`. `eval-cases.test.ts` fails when one skill name prefixes
  another's and no paragraph here names both globs.
- `--runs 1` is a quick look, not a measurement; see
  [Reading a score](#reading-a-score).
- The default judge is Haiku. These graders read long reports, and a small
  judge can fail a correct report on its formatting; pass
  `--judge-model sonnet` when a verdict looks wrong, and read the grader before
  blaming the skill.

Results land in `.claude/evals/results/<timestamp>/`: `aggregate-result.json`
and `report.html`.

## The cases

| Case | Skill | `--allow-tools` | Known limit |
|---|---|---|---|
| `evaluate-tracker-move-cost-pull` | `evaluate` | `Write` | |
| `new-feat-tracker-finding-branch` | `new-feat` | `Bash Write Edit` | |
| `orchestrate-open-issue-tally` | `orchestrate` | `Write Edit` | |
| `orchestrate-parked-draft-waits-on-owner` | `orchestrate` | `Bash Write Edit` | |
| `pick-agent-read-only-auth-survey` | `pick-agent` | `Write Edit` | `named-the-model`, `named-the-effort` |
| `pick-agent-visual-new-status-colour` | `pick-agent` | `Write Edit` | `named-the-model`, `named-the-effort` |
| `pick-agent-visual-token-settled-by-design-md` | `pick-agent` | `Write Edit` | `named-the-model`, `named-the-effort` |
| `prep-pr-changeset-package-name-mismatch` | `prep-pr` | `Bash Write Edit` | |
| `prep-pr-finding-routing` | `prep-pr` | `Bash Write Edit` | |
| `prep-pr-missing-test-written` | `prep-pr` | `Bash Write Edit` | |
| `prep-pr-open-decision-opens-draft` | `prep-pr` | `Bash Write Edit` | |
| `retro-fallback-card-and-routing` | `retro` | `Bash Write Edit` | |
| `retro-restraint-on-a-proportionate-session` | `retro` | `Bash Write Edit` | |
| `review-docs-session-ttl-page-drift` | `review-docs` | `Bash Write Edit` | |
| `review-performance-entitlement-gate-fold` | `review-performance` | `Bash Write Edit` | |
| `review-performance-vendor-read-round-trips` | `review-performance` | `Bash Write Edit` | |
| `review-pr-adopted-branch-red-on-main` | `review-pr` | `Bash Write Edit` | |
| `review-security-access-token-verifier` | `review-security` | `Bash Write Edit` | |
| `review-security-consent-cookie-rediscovery` | `review-security` | `Bash Write Edit` | |
| `review-security-consent-hardened-restraint` | `review-security` | `Bash Write Edit` | |
| `review-security-zap-chat-class-authz` | `review-security` | `Bash Write Edit` | |
| `review-tests-cire-consent-colocated-layout` | `review-tests` | `Bash Write Edit` | |
| `review-tests-pulse-account-cookie-credential` | `review-tests` | `Bash Write Edit` | |
| `write-issue-cire-meal-count-export` | `write-issue` | `Write Edit` | |
| `write-issue-fix-in-scope-step0` | `write-issue` | `Write Edit` | |
| `write-pr-cire-guest-session-ttl-closes` | `write-pr` | `Bash Write Edit` | |

**The `pick-agent` limit.** The skill reads each definition's model and effort
from `.claude/agents/<name>.md`. That directory ships with the plugin, not in
the workspace, and whether the with-plugin arm can read the plugin's own agent
files has not been checked. If `named-the-model` and `named-the-effort` fail in
both arms, this is why, not the skill.

What each case plants and what it scores is in its `setup.sh` header and its
graders. In short:

| Case | Ground truth |
|---|---|
| `evaluate-tracker-move-cost-pull` | A move from GitHub Issues to Jira with a large, growing migration cost and a mixed functional case. Scores whether the answer turns on function, weighs a fix-in-place option and marks unverified vendor claims, rather than letting the migration's size decide. |
| `new-feat-tracker-finding-branch` | A private tracker finding handed over as the work to start. The public repository gains no duplicate issue, and the branch name and plan do not describe the defect. |
| `orchestrate-open-issue-tally` | A subagent's report leaves three issues open; one fits none of the three allowed reasons. Scores the single send-back, the two left open, and the small out-of-scope fix turned into a task of its own. |
| `orchestrate-parked-draft-waits-on-owner` | Two green pull requests at the end of a run: a draft held on an owner decision, and a ready one whose Summary mentions the hold phrase mid-sentence. `.pr/bin/gh` stands in for `gh` and logs every call to `GH-CALLS.log`. |
| `pick-agent-read-only-auth-survey` | A heavy-sounding task whose deliverable is a read-only inventory. The right answer is `explorer` on its own settings. |
| `pick-agent-visual-new-status-colour` | A one-line visual change that needs a colour the surface's DESIGN.md lacks: `designer`. |
| `pick-agent-visual-token-settled-by-design-md` | A one-line visual change the DESIGN.md already settles: `design-mechanic`. |
| `prep-pr-changeset-package-name-mismatch` | A stacked branch whose changeset names a package no `package.json` declares. Assuming `main` is the base pulls in the parent's file and changeset. |
| `prep-pr-finding-routing` | A branch that fixes one tracker finding while a review left five more. Scores where each goes, and a public body that names tracker issues by bare reference only. |
| `prep-pr-missing-test-written` | A new module with no test, reported by the test review. Scores whether the test is written on the branch rather than filed or asked about. |
| `prep-pr-open-decision-opens-draft` | A finished branch whose issue carries an unanswered `needs:decision`. Scores the draft, the hold line closing Impact, and the decision recorded as open for the owner. |
| `retro-fallback-card-and-routing` | A branch whose only card is the unattended fallback's, with null identity. Scores replacing it, comparing spend with the issue's rating, and routing each finding. |
| `retro-restraint-on-a-proportionate-session` | An expensive session that was worth it, with four baits and one real finding. Most points are for not reporting a bait. |
| `review-docs-session-ttl-page-drift` | A branch that updates two of a page's three mentions of a value and renames a heading two links point at. One escaped-pipe wikilink is bait. |
| `review-performance-entitlement-gate-fold` | A gate behind a gate that re-reads the same row. Scores the finding, the fold, and the fold's constraint, one grader each. |
| `review-performance-vendor-read-round-trips` | Three serial pairs of independent single-row reads, and a record dropped by a full page navigation. |
| `review-pr-adopted-branch-red-on-main` | Another tool's pull request with two red checks: the branch's missing changeset, and a test that also failed on `main`. |
| `review-security-access-token-verifier` | A token verifier with no required `exp`, and an issuer check an empty string switches off. |
| `review-security-consent-cookie-rediscovery` | A consent cookie with no `__Host-` prefix, and a revocation that does not tear down loaded embeds. |
| `review-security-consent-hardened-restraint` | The same module with both defects fixed. Half the points are for not reporting them. |
| `review-security-zap-chat-class-authz` | A class check enforced on two operations and missing from their siblings in the same file. |
| `review-tests-cire-consent-colocated-layout` | A package whose tests sit beside their source. Scores resolving the layout from disk before calling any test missing. |
| `review-tests-pulse-account-cookie-credential` | Routes that accept a bearer token or a cookie, tested only with the bearer. |
| `write-issue-cire-meal-count-export` | A planned feature brief. Scores the body, the command's type and labels, and a report that says the issue is not filed. |
| `write-issue-fix-in-scope-step0` | A brief with an in-scope defect the author wants filed, and a planned feature. Only the feature becomes an issue. |
| `write-pr-cire-guest-session-ttl-closes` | A branch that closes a public issue and a tracker finding, leaves a second finding open, is part of an epic and needs a production secret before deploy. |

## Writing a case

Copy `evaluate-tracker-move-cost-pull/`. It has every part, and every other
case follows it.

**`setup.sh`** builds the fixture in the empty workspace, as you, outside the
agent's sandbox, within 120 seconds, with only `PATH`, a temporary `HOME`,
`TMPDIR` and `TERM` set. In order:

1. Refuse a non-empty workspace: every later step rewrites the repository it
   finds.
2. `git init`, then `git fetch --depth 1` of the pinned commit, and check out
   `FETCH_HEAD`. Pin a commit on `main`'s history. A shallow fetch takes seconds; history older than the pinned commit is not
   there to read.
3. Set a local git identity, then turn off `commit.gpgsign` and
   `tag.gpgsign`, so a scaffold run by hand with your own global config signs
   nothing. There is no global git config in the scaffold.
4. `rm -rf .claude .agents`. The checkout's own skills and agents would hand
   the no-plugin arm the instructions under test; the plugin supplies them to
   the other arm. Keep a subdirectory only when the case reads it, as the
   retro cases and `orchestrate-parked-draft-waits-on-owner` keep
   `.claude/metrics/`.
5. Plant what the case needs, build its branches, and commit. Commit the
   removal in step 4 before cutting a branch, or it shows in the branch's
   diff. Keep a planted input that is not a tracked file out of `git status`
   with `.git/info/exclude`.

Time the script by hand before committing it, in an empty directory with the
scaffold's environment:

```bash
mkdir /tmp/case && cd /tmp/case
env -i PATH="$PATH" HOME="$(mktemp -d)" TERM=dumb bash <repo>/.claude/evals/<case>/setup.sh
```

**`prompt.md`** frontmatter sets `description`, `max_turns`,
`timeout_seconds` and `allowed_tools`; an unknown key is an error. The body is
the task as a person would give it.

- State the goal, not the checklist. A task that says "check that the
  changeset is one CI will accept" hands the no-plugin arm the answer.
- Name the deliverable file and say it is the only thing read; the graders
  read that file.
- Keep the Environment lines true: there is no network; say "you have no
  shell" when the case gets no `Bash`.
- `allowed_tools` lists the read-only tools the case uses (`Read`, `Glob`,
  `Grep`, `Skill`, and `Agent` where the skill dispatches a subagent), plus
  `Write`, `Edit` and `Bash` only where the task needs them. Add a case's
  grants to the table above.
- Set `max_turns` and `timeout_seconds` from how long the task takes, not the
  defaults (10 turns, 300 seconds). A full review or pre-PR run here can take
  an hour; those cases use the limits, 200 and 3600.

**`case.yaml`** holds `schema_version: "1.1"`, `name` and
`context.scaffold_script: setup.sh`.

**`graders/`** holds one check per file.

- An `llm` grader's body is its rubric. The judge sees only the grader and the
  file its `focus` names, so the body carries the ground truth that check
  needs, then `PASS if` and `FAIL if`, and ends "FAIL also if the file is
  missing or empty": a rubric that passes on absence passes a run that wrote
  nothing.
- Graders are pass/fail: a judge votes three times and two passes win. A
  check whose parts are independent, or that scores in tiers, is one grader
  per part, each at its own full bar, with the weights summing to what the
  check is worth. A tier that needs a lower one says so in its own rubric.
- `weight` sets how much a grader counts.
- What the tool log proves goes to a `tool_used` or `tool_order` grader, which
  costs nothing: no `Write` or `Edit` outside the deliverables (`input_match`
  on `file_path`), no `git commit`, a command that must run, one command before
  another. The cases here let a `Write` under `/tmp/` pass, since a skill may
  write a scratch file there; that assumes the workspace is not under `/tmp`,
  which holds on macOS, where `TMPDIR` is under `/var/folders`.
- Write the rubric from the tree, not from memory of the change: run
  `setup.sh` in an empty directory, read the files it builds, and list the
  branch's diff with `git diff --name-only main...HEAD`. A grader that names a
  file not in the diff is reading the base branch; say so.

## What makes a case discriminate

- **The score measures what the plugin adds to the repository**, not what the
  agent knows. The no-plugin arm still has the fixture's root instructions
  file, its wiki and its scripts to read. A grader discriminates only if it
  checks something the skill says and nothing else in the fixture does: grep
  the fixture commit for the fact before weighting a grader on it.
- **A case must be verifiable from the fixture tree.** The ground truth is a
  file at a commit, never a claim about the run's environment that nobody can
  observe.
- **Pair a rediscovery with a restraint case.** Every merged fix is a labelled
  example: pin its parent commit and write a grader per finding it fixed. The
  same module one fix later, with the defects gone, scores whether a review
  reports what the code does rather than what such code usually gets.
- **The rubric must not contradict the skill.** A grader that penalises
  breadth names what counts as filler in this repository's terms, or it fights
  the behaviour under test. A grader that forbids writing a file the skill
  tells the agent to write fails the arm that follows the skill.
- **Keep provenance out of the case.** No pull-request number in a prompt or a
  grader, and `setup.sh` comments describe mechanics, not the answer.
- **Never put an arm marker in the deliverable.** A comment naming which arm
  wrote a report unblinds the judge.
- **Keep the fixture consistent.** A branch whose diff, commit message and
  changeset agree reads as ordinary work; `origin` pointed at the checkout
  itself lets a skill's opening fetch succeed.

## Reading a score

- One run is noise. The same skill text has scored full marks and zero on two
  cases of a single run, and a case's score moves between identical runs by
  more than most skill edits do. Quote the plugin's `Δ` over a skill's cases
  across several runs; read one case's movement as a reason to look, not as a
  result.
- When an edit does not land, look for a contradiction between two passages of
  the skill before rewording one. Rewording an instruction the agent already
  ignores rarely moves it.
- A grader that both arms pass every time measures the repository or a guard
  nothing trips, and dilutes the `Δ`.
- Scores from these cases do not compare with earlier scores from another
  harness: the format, the judge and what loads into the session all differ.

## Known limits

- **The fixture's root instructions do not load.** `claude plugin eval` loads
  no `CLAUDE.md` or `AGENTS.md` from the workspace, in either arm; the agent
  can read them as files.
- **The sandbox makes some of git read-only.** Under `Bash`, the agent cannot
  write `.git/config` or `.git/hooks`. `new-feat-tracker-finding-branch` sets
  `branch.autoSetupMerge false`, so cutting a branch from `origin/main` writes
  no upstream there.
- **Edits made through the shell are invisible to the `Write` and `Edit`
  graders.** Where a case grants `Bash`, `sed -i` or a redirect can change a
  tracked file without a grader seeing it.
- **The judge reads one file.** A check that needs two deliverables is two
  graders, and a fact a grader needs from the fixture is written into its
  body.
- **A scaffold proves the fixture, not the run.** Running `setup.sh` by hand
  shows the fixture builds; only a run shows the agent's own git commands work
  in a shallow repository under the sandbox.
