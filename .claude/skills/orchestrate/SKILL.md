---
name: orchestrate
description: Use when driving one or more tasks end to end from the local bare repo's `main` worktree — a feature designed with the user first when its scope is open, or a ready list of tasks — ordering them, cutting a worktree per task, handing each to a subagent that runs new-feat, running prep-pr with every finding fixed rather than reported, and shepherding each pull request to a squash merge and worktree teardown. Also the route for a request to review and fix an open pull request another tool or session wrote, through review-pr. Not for a one-file change, and not outside the bare repo.
---

Orchestrate `$ARGUMENTS` end to end. If it is empty, or asks what to work on next, run the `next-batch` skill first: it reads the project board and returns the task list.

You are the orchestrator: you order the work and drive the loop, and you **do not plan or write the implementation of any task** — a subagent does that through `new-feat`. Your context is the scarce one; theirs is disposable.

## What this run must produce

Every task merged into `main` as its own squash-merged pull request, the worktree this run created for it removed, and a closing summary: each PR (number and one line), anything deferred as a tracked follow-up, any deploy-time or human action a subagent surfaced, any issue a merge did not close that the owner must close by hand, and any worktree left in place because another tool or session made it.

## Precondition — the local bare-repo setup, run from `main/`

This skill creates worktrees, so it needs the local bare repo. **Run it from the
`main` worktree, not the bare root:**

```bash
git -C /Users/ac/.work/osn.git rev-parse --is-bare-repository                # expect: true
[ -d /Users/ac/.work/osn.git ] && [ "$(uname)" = "Darwin" ] && echo OK
pwd                                                                          # expect: …/osn.git/main
```

`git worktree add` resolves against the shared bare repo, so it works just as
well from `main/` as from the root. The reason to prefer `main/` is what the
session records look like afterwards. A bare repo has no checked-out branch, so
Claude Code stamps every record of a session started there with
`gitBranch: "HEAD"` — an anonymous bucket that no card and no report can name.
From `main/` the same records read `main`, which is a label you can measure and
subtract. 64% of this repository's recorded token spend currently sits in that
anonymous `HEAD` pool, and moving the orchestrator is most of the fix.

Anywhere else — the remote environment, a container, or inside a *task*
worktree — **stop** and say: "orchestrate needs the local bare repo so it can
create worktrees — run it from `/Users/ac/.work/osn.git/main`, or use
`new-feat` and `prep-pr` in place instead." There is no static equivalent of
this run; the deliverable is merged pull requests.

> [!warning] An orchestrated task is carded only if every dispatch carries the branch.
> `gitBranch` is captured once when a session starts and inherited by every
> subagent it dispatches — it is a property of the session, not of the work, and
> `isolation: "worktree"` does not change it: that pins a subagent's `cwd`
> correctly and still reports the parent's `gitBranch`. So a subagent building in
> a task worktree would record the *orchestrator's* branch, and the task's own
> card would read zero.
>
> What closes that is the `TASK-BRANCH:` marker in Step 3 — the collector reads
> it back out of the dispatch prompt. **It is the whole of the attribution, and
> it fails silently**: a dispatch that omits the line does not warn, it just
> banks that subagent's spend against the orchestrator's own branch, where
> nothing will look for it.
>
> So put it in every prompt this skill sends — hand-offs, fix subagents,
> reviewers, shepherds, re-dispatches — and check the run afterwards rather than
> assuming. Every task branch should appear in:
>
> ```bash
> bun run --cwd tools/pr-metrics backfill -- --dry-run
> ```
>
> A branch missing from that list was not attributed. See
> `wiki/conventions/session-metrics.md`.

## The blackboard

Write `ORCHESTRATE.md` in the `main` worktree — outside every *task* worktree, so
no `.gitignore` governs it and no worktree can stage it, which is the point: one
file for a run that spans several branches. Rewrite it at every step
boundary — a task dispatched, a gate run, a commit made, a PR opened. A long run
gets compacted, and what survives a compaction is what was written down, not what
you were holding in context. Read it first after any compaction, before touching a
worktree. One block per task:

```markdown
## task 3 — vendor enquiry weddingName
issue:       englishstventures/osn#812
claimed:     osn#812 item 264995573
agent:       implementer — new field on a route response plus its test; rating unconfirmed, chosen from the text
premises:    checked on origin/main 435c28f65
  - the route file is cire/api/src/routes/vendor-enquiries.ts
    `git ls-tree --name-only origin/main cire/api/src/routes/ | grep enquir` → organiser-enquiries.ts, vendor-enquiries.ts
  - the wedding's name column is display_name, not name
    `git show origin/main:cire/db/src/schema.ts | grep -n display_name` → 27:    displayName: text("display_name").notNull(),
worktree:    /Users/ac/.work/osn.git/vendor-enquiry-name (made by this run)
branch:      feat/vendor-enquiry-name (base origin/main)
pr:          not opened
running:     a3f9 implementer (hand-off; ends when it reports) · b71c wait-pr.sh 845 (terminal state or 30 min)
gates:       check ok · lint ok · test:run NOT RUN · fmt:check NOT RUN
findings:    plan 1 · brief 0 · worker 2
next:        stress-plan finding #2 still open — the DoD names a command that runs nothing
```

`NOT RUN` is a real value and usually the honest one: a gate whose result you
cannot name off this file has not been run, whatever anyone reported. `findings:`
counts where each finding came *from* — the plan's when the plan said to do the
wrong thing, the brief's when the instruction was right but under-specified, the
worker's when the brief was right and the code is not. It costs one line and it is
the only signal that says which stage to spend more on.

`agent:` is the definition `pick-agent` chose for the hand-off (Step 3) and the
reason in one line. `premises:` holds every claim the brief makes about the
code, each with the command that checked it on `origin/main` and the output that
answered (Step 1). A task block with no `agent:` or no `premises:` line is not
ready to dispatch. `worktree:` says who made it — this run, or another tool or
session — because Step 5 removes only a worktree this run made, and after a
compaction this line is the only record of which. `running:` names every
background task this run started for the task — subagent, shepherd, `Monitor`,
background shell — with its id and what ends it; the sweep in Step 5 reads it.

## Step 00 — Feature or task list?

Classify the input before ordering anything.

- **A ready task list** — concrete changes, each with clear acceptance criteria ("add `weddingName` to the vendor enquiries response", "wire `astro check` into the two cire frontends"). Go to Step 0.
- **A feature** — open scope, needs product or design direction, spans subsystems, or is big enough to want phases. Run the design phase first. When unsure, treat it as a feature: a short design gate is cheaper than a subagent guessing at scope.
- **An open pull request to review and fix** — "review and fix PR #N", usually one another tool or session wrote. The branch and the pull request already exist; follow [Adopting an open pull request](#adopting-an-open-pull-request), which changes Steps 2 to 5.

**The design phase is interactive; the build loop is not.** Do it with the user, synchronously, before any subagent exists:

1. `superpowers:brainstorming` turns the idea into an approved spec at `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`. It has a hard gate — no worktree, no plan, no implementation until the user approves — and a feature spanning independent subsystems comes out as sub-project specs, which become your phases.
2. `superpowers:writing-plans` turns each approved spec into a task-by-task plan at `docs/superpowers/plans/YYYY-MM-DD-<name>.md`, one per phase. Note each plan's **Global Constraints**; they go into every dispatch.
3. Run the `stress-plan` skill on each phase's plan before dispatching that phase. A wrong assumption in a plan is copied faithfully by a good implementer and comes back as a clean diff doing the wrong thing; no downstream review catches it, because every downstream review checks the work against the plan rather than the plan against the repo. Every finding is closed before Step 2 cuts the worktree: fixed in the plan, rejected in writing only when you can name the fact it got wrong, or escalated to the user when its facts stand and the choice is theirs. An escalated finding waits for the answer.
4. The ordered phases are the tasks Step 0 orders — one phase, one branch, one PR. Inside a phase, the plan's tasks are the subagent's work, not yours.

Point every dispatch and every reviewer at the phase's **plan file path** and its Global Constraints. The plan is the single source of requirements; do not paste task detail into a dispatch.

For a feature with more phases than prose can hold, a `.canvas` beside the plan (`obsidian:json-canvas` — one node per phase, edges for dependencies, labelled with the files two phases both touch) lets the user check the ordering. Optional, and the plan file stays the source of truth.

## Step 0 — Order the work

Parse the input into discrete tasks and plan **structure only**:

- **Order by dependency.** A task another builds on, or that touches files another touches, goes first. Independent tasks still run through this loop one at a time; parallelise only when they share no files and you will manage separate worktrees.
- **One task, one branch, one PR** by default. Group two only when they are genuinely one unit of work.
- **A task with no clear acceptance criteria is not dispatched.** Ask the user to clarify before a subagent guesses at scope; if it needs product direction, that is Step 00.
- **A list from `next-batch` arrives triaged**, ordered, and grouped by the files each task touches. Keep its order and its limit on agents running at once.

State the ordered list and which tasks get their own branch in one short message, then start. Do not describe how any task will be built.

## Per task — Steps 1 to 5, in order

### Step 1 — Gather context, lightly

Collect **orientation pointers** for the subagent: the files in play, the pattern to copy from elsewhere in the repo, the schema and types involved, the footguns. The `explorer` agent, grep, Read. This is context, not a design.

**Hit the wiki before the source** — its system pages already hold the contract, the finding history and the footguns. Use the three-tier ladder in `AGENTS.md` §The wiki (detail in `wiki/conventions/wiki-search.md`), pulling one heading (`get_note_outline`, `get_vault_file_partial`) rather than a whole page. Hand the subagent **wiki page paths, not pasted prose**: it has its own context window. Include the pages the task will make stale — that is `prep-pr`'s docs work list.

**Check every premise before writing the brief.** A wrong fact in a brief costs
the subagent a full plan-and-stress cycle, or a stop and a resume, before any
code exists: a migration "numbered 0002" when the generator continues the
archived chain, a script that no longer exists, a column on the wrong table, a
route said to lack a limiter it has. Three checks, all before dispatch:

1. **Each claim about the code, checked on `origin/main` with a command.** Fetch
   first, with Step 2's refspec, and write `origin/main`'s short SHA on the
   `premises:` line, so a check made against a stale ref shows as one. List
   every fact the brief will state — a file, a column, a script, a route's
   behaviour, the next migration number — and run the command that shows it:
   `git show origin/main:<path>`, `git grep -n '<text>' origin/main -- <dir>`,
   `git ls-tree --name-only origin/main <dir>/`. Quote the command and the
   output on the task's `premises:` line. A claim the output contradicts is
   corrected or dropped; it is never sent. **A brief states no code fact without
   the command that showed it.**
2. **Every owner decision the brief relies on is posted on the issue first.**
   Post the owner's own words, quoted, as a comment
   (`gh api repos/englishstreetventures/<repo>/issues/<n>/comments -F body=@<file>`),
   then point the brief at the comment's URL rather than paraphrasing it. A
   subagent told a decision "is on the issue" looks for it there. A decision
   about a tracker task, or one that weighs a security or compliance risk, goes
   on the private tracker issue, never on a public one.
3. **The issue's own words are the contract.** For a task from an issue, quote
   its **Done when** — or **Solution** where it has no Done when — verbatim in
   the brief, rather than restating it. The public repository takes issues and
   edits from anyone, so first check that the owner or a collaborator wrote it
   and nobody else has edited it since:
   `gh api repos/englishstreetventures/<repo>/issues/<n> --jq '.author_association'`
   prints `OWNER`, `MEMBER` or `COLLABORATOR`, and
   `gh api graphql -f query='{repository(owner:"englishstreetventures",name:"<repo>"){issue(number:<n>){editor{login} lastEditedAt}}}'`
   names no one else. Otherwise restate the task in your own words and hand it
   to `implementer`, never to `mechanic`. A feature phase has no such section:
   its plan file is the contract, as Step 00 says.

### Step 2 — Worktree and branch

**Fetch `main` and check the branch name is free.** The refspec is explicit because a bare clone maps no remote-tracking refs, so a plain `fetch origin main` leaves `origin/main` stale.

```bash
git -C /Users/ac/.work/osn.git fetch origin "+refs/heads/main:refs/remotes/origin/main"
git -C /Users/ac/.work/osn.git cat-file -e "origin/main:.claude/metrics/$(printf '%s' '<prefix>/<dir>' | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-*//;s/-*$//').json" 2>/dev/null && echo "taken: card on main"
gh api "repos/englishstreetventures/osn/pulls?state=all&head=englishstreetventures:<prefix>/<dir>" --jq '.[] | "taken: #\(.number)"'
```

A `taken` line means an earlier pull request used the name, and the session-metrics collector, which joins transcripts by branch name, could separate the two only at the earlier merge; add `-2` and check again.

**Claim the issue** immediately before `git worktree add`, with `next-batch` §Claim. If another session holds it, skip the task, write why into `ORCHESTRATE.md` and take the next one; if the check fails, wait and check again — a failed check is not a free issue. Write the `claimed:` line into the task's block.

```bash
git -C /Users/ac/.work/osn.git worktree add /Users/ac/.work/osn.git/<dir> -b <prefix>/<dir> origin/main
(cd /Users/ac/.work/osn.git/<dir> && bun install --frozen-lockfile)      # a fresh worktree has no node_modules
```

`<prefix>` is `feat/`, `fix/`, `chore/`, `refactor/` or `docs/`; `<dir>` is the branch name without it. Skip only when the task genuinely continues an existing, unmerged branch. A task that stacks on an open PR's branch is cut from that branch and gets `git config branch.<name>.gh-merge-base <parent>` — `wiki/conventions/stacked-prs.md`.

### Step 3 — Hand the task off, whole

Dispatch **one** subagent that owns the task. Give it the task, the Step 1 pointers and premises, the worktree path and branch, and these instructions.

**Which one: apply the `pick-agent` skill to every hand-off and every re-dispatch of it**, and write its answer on the task's `agent:` line before sending. Load it once per run, and again after a compaction; its text does not change between dispatches. Its §The rubric table and its complexity table decide — `implementer` for anything that designs something, `designer` for work that changes how a screen looks, `mechanic` for work whose answer is fixed before it starts — and it says why a `complexity:unconfirmed` rating counts for nothing. Three cases decide most hand-offs:

- A skill-text, docs or test-only task whose issue already states the change — the wording, the test — goes to `mechanic`, once Step 1's third check has passed: a `mechanic` applies the issue's words exactly, so they must be the owner's.
- Reviewing and fixing an open pull request is whole-task work and goes to `implementer`, or to `designer` when the pull request is UI work. A review that fixes nothing goes to `reviewer`, a plan attack to `attacker`; neither ever goes to `implementer` or `general-purpose`.
- Anything the rubric does not settle goes to `implementer`: defaulting up is recoverable, and defaulting down produces a subagent that does a worse job and reports success. Unsure means the rubric did not settle it, not that it was not run.

**The dispatch is a contract, not a description.** A subagent inherits no
conversation, so anything not in the text does not exist, and anything wrong in it
gets followed to the letter. Every dispatch carries:

- **The branch, as the first line: `TASK-BRANCH: <branch>`.** On its own line,
  verbatim, in **every** prompt this skill sends to the `Agent` tool — Step 3's
  hand-off, Step 4's fix subagents, Step 5's shepherd, and every re-dispatch.
  A subagent's `gitBranch` is the *orchestrator session's*, captured once at
  session start and inherited, so without this line its spend is attributed to
  `main` and lands on no card. It is 85.8% of subagent spend today. The
  collector reads the marker back out of this prompt
  (`tools/pr-metrics/index.ts`, `resolveDispatchBranch`); a subagent that
  dispatches further work does not need to repeat it, because a child with no
  marker inherits its parent's.
- **The claim, as the second line: `CLAIMED: <repo>#<n>`**, in the hand-off for
  a task from the board. `new-feat` Step 0 runs the claim check itself unless
  its brief carries this line, and would find your claim and stop.
- **The reader.** Every file the task creates names the file or command that reads
  it. If nothing reads it, the task is not done — "create the file" and "make
  something call it" are separate steps, and an implementer reliably does the
  first and skips the second.
- **The issue's Done when, verbatim**, and the premises from Step 1, each with
  the command that showed it.
- **Never invent an identifier.** Hostname, key name, path, port, flag, package
  name. Unknown value means stop and report `NEEDS INPUT`, never a plausible
  placeholder.
- **The command to run.** Name it, and make sure it actually runs the thing: a
  type check is not a run, and `bun test ./scripts/` collects no `*.test.sh`.
- **Commit on the branch.** An uncommitted tree is not a result.
- **Report only what git cannot tell you** — assumptions, deviations, blockers.
  You read the diff for everything else.
- **The shared files** this task touches that another task also touches. That is a
  real dependency and belongs in the order alongside the logical ones.
- **The wiki pages to read, by repo path**, and the ones this work makes stale.
  Paths, never pasted prose — the subagent has its own context window and can open
  a file; yours is the run's bottleneck.

`test -e` every path a dispatch names before sending it. A whole task has been
lost to a directory that did not exist, and that was the orchestrator's fault.

Then the instructions themselves, for an `implementer` or `designer` hand-off:

- Invoke the `new-feat` skill and follow it — it routes to the right sub-skills. Plan the implementation itself; do not wait for a plan from you.
- Match repo conventions (`AGENTS.md`, the product's `wiki/<product>/<product>-development.md`), add the changeset, follow the observability rules, write tests — TDD where there is logic.
- Edit wiki pages with Edit/Write in its own worktree, invoking `obsidian:obsidian-markdown` for the syntax. Say explicitly: the Obsidian MCP and the `obsidian` CLI both point at `main`'s `wiki/`; they read, never write.
- **Commit on the branch; do not push and do not open a PR** — Step 4 owns that.
- On a decision it cannot resolve from the context and sensible defaults, **stop and return `NEEDS INPUT: <question> + options + recommendation`** rather than guess.

Do not re-implement or second-guess its design. Its final message is a report to you, not to the user.

**A `mechanic` hand-off does not run `new-feat`.** The definition applies a change
whose answer the brief already holds, so the brief carries that answer: the
issue's Fix and Done when, verbatim, the files the issue names and the command
that proves the change. You are not designing it — the issue states it, which is
what made the task mechanical. Its instructions: apply the change exactly,
commit on the branch, do not push, and return `NEEDS INPUT` the moment the
change needs a decision nobody has made. A `NEEDS INPUT` from a `mechanic` is
answered by re-dispatching the task to an `implementer` with the question in
its brief, and the `agent:` line changes to say so.

For a **large phase** — a plan with many independent tasks — tell the subagent to run `superpowers:subagent-driven-development` against the plan file instead of `new-feat`: a fresh implementer per task, a review per task, a review of the whole branch, all inside the one branch. Still one PR; `prep-pr` runs once at the end. That plugin's templates dispatch `general-purpose` with a `model`; tell the subagent to route them as `pick-agent` §Never `general-purpose` says — cheapest-tier implementer prompts to `mechanic`, the rest to `implementer`, the final whole-branch review to `reviewer`, per-task reviews left as the plugin dispatches them.

### Step 4 — `prep-pr`, with findings fixed

**No subagent's stated verification counts.** Before reading a word of its report,
check the mechanical half yourself in its worktree: the commit exists and the tree
is clean (`git -C <dir> status --porcelain`, `git log --oneline <base>..HEAD`), no
conflict markers survived a rebase, no brief or scratch file was committed, every
JSON and TOML the branch touched still parses, and `git -C <dir> diff --stat`
shows it touched what it claimed. Each of those has caught a report that was wrong
— including one quoting a commit SHA it had invented. Then read the diff, then run
the gates.

Two rules for anything you dispatch into a worktree:

- **A reviewer builds only when it is alone in the worktree.** Read-only means
  read-only about the tree, not just about your files: two builds running at once
  in one checkout interleave their output into a directory that never existed,
  and the measurements taken from it are not real. Say in each brief whether the
  `reviewer` is alone; when it is not, take the measurements yourself, in a
  worktree nothing else is touching. A finding quoting a measured number states the worktree and the file
  count it measured, so you can reject it on sight when the count disagrees with
  what the app emits.
- **One code-writing agent per worktree**, and never a review alongside your own
  uncommitted edits. A review agent comparing an old shape against a new one
  reaches for `git checkout <ref> -- <path>`, and putting it back discards
  whatever you had uncommitted in that tree. Only `reviewer` agents share a
  worktree, as `prep-pr` Step 6 runs two: their tool grant has no `Edit` and
  their definition tells them never to change the checkout.

Run the `prep-pr` skill on the branch. Its own steps validate the changeset, build and test, run `review-tests`, and run the performance and security reviews in parallel. This skill's contract is stronger: **after the reviews, dispatch fix subagents to add the missing tests and fix every security and performance finding** — Critical, High and Medium at minimum, Low and Info when cheap — then re-verify. Choose each fix subagent with `pick-agent`, as Step 3 does: a missing test whose cases the review already spells out is `mechanic` work, and a fix that needs a design is `implementer` work. Record each on the task's `running:` line until it reports. **Critical and High are not deferrable at all**: fix them here, or open the follow-up pull request immediately and link it before either merges — see `wiki/conventions/review-findings.md`. A Medium deliberately deferred is carried into the PR body as a tracked follow-up. Scale review depth to the change: a docs or config PR does not need three review agents; an auth, route or binding change does. Then the PR body with the `write-pr` skill, push, and open the PR. Once it is open, move the issue's card to In Review (`next-batch` §Claim, step 4).

### Step 5 — Retro, then watch, merge, tear down

**First, the card.** Invoke the **`retro`** skill on the task's branch before
the wait starts. It writes and commits the session-metrics card with
the pull request's identity on it, and reads what the task cost against the
complexity declared at Step 1. Under this skill that matters more than
anywhere else: an orchestrated task's spend sits in subagent transcripts, and
the card is the only place it is ever added up. Skip it and the task's own cost
is unrecoverable once the worktree is torn down at the end of this step.

**Then wait, with an end, and keep the polling out of your context.** If the
pull request was opened as a draft, run `gh pr ready <n>` first and give it ten
seconds. Then run the wait yourself in the background, as **Every wait ends**
below says:

```bash
bash scripts/wait-pr.sh <n> 30     # run_in_background; one line when it ends
```

The polling never enters your context — you get one notice and one line. A
green line needs nothing more. On a red line, dispatch a **`shepherd`
subagent** (`.claude/agents/shepherd.md`) to read the failing job and return its
name and the decisive line of its output, not the whole log; reading logs does
not need an expensive model. The shepherd does not merge, does not rebase, does
not push and does not remove a worktree: those are the only irreversible
operations in this loop, and `shepherd` pins the cheapest model in the fleet
precisely because it is not the thing making that call. Then you act on what the
line and the shepherd report:

- All checks green and `mergeStateStatus: CLEAN` → **you** run `gh pr merge <n> --squash --delete-branch`.
- `DIRTY` or `BEHIND` → dispatch an **`implementer`** to rebase onto the latest `origin/main`, resolve conflicts (sibling PRs that merged first are usually additive — keep both sides; for changeset or version churn from the release workflow, take the regenerated state), re-run the touched package's tests and `git push --force-with-lease`. Conflict resolution is a judgement call and a force-push is not recoverable, so neither belongs to the polling agent.
- A check failure → first find out whose it is: a test or error line that also fails on `main`, or one the branch never touches that passes on a rerun, is not this branch's to fix (`review-pr` Step 4 has the commands). A real failure of the branch's → dispatch an `implementer` fix subagent, push, re-poll. Never merge red.
- Once `MERGED`, **you** remove the worktree this run created and delete the local branch: `git -C <dir> status --porcelain` must print nothing first, since `--force` would take uncommitted work with it, then `git worktree remove --force <dir>`. Never leave one of those behind. A worktree another tool or session made — an adopted pull request's — stays where it is, and the closing summary names it.
- Once `MERGED`, carry into the closing summary every close the subagent reported it could not make — tracker lines the classifier refused, a stacked pull request's closes that never registered (`write-pr` Step 6). Those issues stay open until the owner closes them by hand.

**Between dependent tasks:** fetch `main` with Step 2's refspec and fast-forward local `main` so the next worktree is cut from the updated tip. If a later task's branch already exists and now conflicts, rebase it before its Step 5.

#### Every wait ends

A wait with no end holds its slot against the account's usage limit and tells
the owner work is moving when it is not. Three rules, for every wait this run
or any subagent starts — your own CI wait, a `Monitor`, a background loop, an
agent watching its own CI:

1. **It names its terminal states and a deadline, and it ends on either.** For a
   pull request the terminal states are `MERGED` or `CLOSED`; `DIRTY`, which
   runs no checks until a rebase; any check in the `fail` bucket; or at least
   one check and none `pending` — `pass`, `skipping` and `cancel` all count as
   finished. For a single workflow run it is `status: completed`, whatever the
   conclusion: `success`, `failure`, `cancelled`, `timed_out`,
   `startup_failure`. An empty check list is not terminal, since a pull request
   has none until its workflows register after a push. The deadline is 30
   minutes for CI unless the brief sets another; when it passes, the wait
   prints the last state it saw and exits. A filter that prints only on
   success is silent on a failure, and silence reads as "still running".
   `scripts/wait-pr.sh` does all of this for a pull request, in one GitHub
   request per poll, and waits for two quiet polls running before it calls a
   pull request done, since a job that depends on others registers late:

   ```bash
   bash scripts/wait-pr.sh <n> 30   # exit 0 done, 1 needs action, 2 no verdict by the deadline, 3 cannot answer
   ```

   The Bash tool stops a foreground call after ten minutes and refuses a
   foreground `sleep`, so run it with `run_in_background`, which sends one
   notice when it exits. A `Monitor` works too, but expires after 30 minutes
   at most, so give the script a shorter deadline than its `timeout_ms`.
   Either way the script's own deadline ends it with a line, and you work on
   something else meanwhile.
2. **A subagent that dispatched reviewers or watchers collects or stops them
   before it returns.** Every brief that lets a subagent dispatch says so;
   `prep-pr` Steps 4 and 6 say it for their reviewers.
3. **At each step boundary, sweep.** Read every `running:` line in
   `ORCHESTRATE.md` and the harness's own task listing; stop with `TaskStop`
   anything whose pull request has merged or whose purpose has passed, and
   strike it from the line. Trust the ledger over the listing: a listing can
   show a task as completed while it still runs, so a task you started and
   never saw report is stopped anyway — stopping a finished task does nothing.

## Adopting an open pull request

"Review and fix PR #N" hands you a branch, a pull request and usually a
worktree that already exist, often made by another tool. The `review-pr` skill
holds the procedure; this run changes around it as follows.

- **Step 1** as usual, and the premises include the PR's head branch and
  repository, the issue it closes, and its worktree:
  `git worktree list | grep -F "[<branch>]"`.
- **The claim.** The open pull request already holds its issue in `next-batch`
  §Claim's terms; the owner's request is what lets you take it. Write
  `claimed: <repo>#<n> (adopting PR #N at the owner's request)` and leave the
  card in, or move it to, In Review. If the issue is In Progress and you did
  not move it there, another session may be working on it: ask the owner.
- **Step 2 is skipped.** The branch's own worktree replaces it; `review-pr`
  makes one only when none exists, and then this run owns it.
- **Step 3** dispatches an `implementer` whose brief says to invoke `review-pr`
  on PR #N in that worktree, not `new-feat`. The pull request already exists,
  so the hand-off pushes and rewrites the body itself: the usual "do not push"
  instruction does not apply. It stops after the push and reports; the CI wait
  is Step 5's.
- **Step 4.** `review-pr` has already run `prep-pr`'s gates and reviews and
  rewritten the body. Do the mechanical checks and read the diff and its
  report as usual; do not run `prep-pr` again — its Step 9 would open a second
  pull request.
- **Step 5** as usual, except the teardown: remove the worktree only if this
  run created it, and name any other in the closing summary.

## When a subagent dies mid-task

Session limits, API errors and crashes all land the same way: the agent stops and
the worktree holds a partial change nobody has verified. Do not re-dispatch into
it blind — a second agent inherits half-finished edits it did not make and cannot
tell them from the tree.

1. `git -C <worktree> status --porcelain` and `git log --oneline <base>..HEAD`.
   Committed work is salvage; an uncommitted tree is a draft with no author.
2. Read the partial diff yourself. Decide one of three things and write the
   decision into `ORCHESTRATE.md`: finish it yourself, re-dispatch with a brief
   that names what is already done, or `git restore` and start the task over.
   A task dropped for good goes back to Up Next (`next-batch` §Claim, step 4).
3. Re-dispatching wins only when the remaining work is large and separable. Below
   roughly a file's worth, finishing it yourself is cheaper than writing a brief
   that describes someone else's half-finished tree.
4. A limit that resets on a clock is a wait, not a failure. Park the task in
   `ORCHESTRATE.md` with `next:` filled in and pick up a task that touches no file
   this one touches.

## Handling subagent questions

Subagents cannot prompt the user; they surface `NEEDS INPUT` in their report. Then:

1. **Answer it yourself** from the task, the codebase, repo conventions, prior decisions this session and sensible defaults — by continuing that agent (`SendMessage` to its id) or by dispatching the next step with the decision baked in.
2. **Escalate to the human only when it is genuinely their call** — a product or scope choice, a value only they hold (real domains, account ids, legal copy), spend, anything outward-facing or irreversible. Ask concisely with clear options, then feed the answer back.
3. Never let a subagent block silently or guess on a consequential decision.

## Gotchas

The full table, with the reason behind each, is `references/gotchas.md`. The ones that cost a run:

- Feature input dispatched straight into the loop → the subagent guesses scope. Step 00 first.
- `gh pr ready` does not propagate at once; a still-draft PR shows `BLOCKED` with green checks. Wait, then read.
- Pre-push runs `bun audit --audit-level=high`. An advisory in an installed package is a real stop; do not push with `--no-verify` to get past one — fix or override it in `package.json` and say so in the PR. When no fixed version exists, an `--ignore` entry is possible only on the terms in the comment above `audit` in `lefthook.yml`, with its dated `DROP AFTER` marker (never for a malicious-package advisory), and it is the owner's call, not yours: write the evidence into the issue, label it `needs:decision`, and do not merge that pull request until the owner approves it.
- Merging several PRs in sequence: the release workflow versions on every merge, so sibling PRs touching `wrangler.toml` or an `index.ts` conflict. Merge in dependency order and rebase additively.
- Wrangler named environments inherit no top-level bindings. Every `[[d1_databases]]`, `[[r2_buckets]]` and `[images]` is mirrored into `[env.production]` and `[env.dev]`; verify with `wrangler deploy --dry-run`.
- A wait with no end — a loop that prints only on success, a reviewer nobody collected, a watcher left running after its PR merged — holds a slot against the usage limit until the owner notices. Step 5, **Every wait ends**.

## When not to use this

A one-line or single-file change — edit it and open the PR directly. Outside the local bare repo — `new-feat` then `prep-pr` in place.
