# Tessl task evals for this repo's skills

A task eval runs an agent against a scenario **twice** — once without the skill,
once with it — and scores both against a rubric. The gap is the skill's value.
A skill that scores the same either way is not steering anything.

## Layout

Tessl attaches evals to a *plugin* (a "tile"), not to a loose markdown file. The
plugin root here is `.claude/`:

```
.claude/
├── .tessl-plugin/plugin.json     # name, version, workspace
├── tessl.json                    # written by `tessl project create` — NOT yet committed
├── skills/<name>/SKILL.md
└── evals/<scenario>/
    ├── task.md                   # free-form markdown — the ONLY file the agent sees
    ├── criteria.json             # weighted checklist the judge scores against
    ├── scenario.json             # fixtures, includes, setup
    └── setup.sh                  # auto-run last, after fixtures land
```

A checklist item is `{ name, description, max_score }` — and nothing else; the
CLI warns on any extra field. Weight the items that carry the scenario's point,
and put a prohibition in the description as "MUST NOT ...", since there is no
category field to say it for you. `tessl eval lint .claude` checks this.

## Before the first run

Two things are missing on purpose, because both need a Tessl account:

The plugin is linked to the `musubi` workspace, and `.claude/tessl.json` names
the project every run is saved to. Both are committed. If that link ever breaks,
`tessl project repair` from `.claude/` fixes it — the project is created there
rather than at the repo root on purpose, because a root `tessl.json` is not on
the changeset allowlist and would force a changeset on every PR that touched it.

## Running

```bash
tessl eval run .claude                 # all ten scenarios, baseline + with-skill
tessl eval view --last
tessl scenario generate .claude --count 3   # draft more scenarios
tessl scenario download --last              # run from INSIDE .claude/ so they land in evals/
```

## The inner loop

A full run is ten scenarios, two variants, three runs each — sixty agent solves,
which is most of a working day and hundreds of credits. The harness launches a
whole run index at once (17–20 solves) and waits for the slowest before starting
the next, so wall clock is the sum of the waves' maxima, not the mean solve:
run 7 took 290 minutes for 19.4 agent-hours, and one straggler held its last
hour on its own. Almost none of that work answers the question a skill edit
asks.

**Nothing in CI waits for it.** `skill-eval.yml` narrows the run to the skills
the diff touched, submits it, leaves the run id in a pull-request comment and
exits in a couple of minutes. `skill-eval-collect.yml` sweeps every 30 minutes,
finds comments whose run has scored, and edits the table in. Holding a runner
for the hour a run takes, to produce a number nothing is gated on, is the wrong
trade — and an hour-long job is also the one a force-push cancels and bills
twice.

Two signals come out of it, and they are deliberately different in kind:

- **The quality score files an issue.** It is deterministic — the same
  `SKILL.md` scores the same twice — so a five-point fall, or anything under
  70, is real and can be acted on without a second run. One open issue is
  reused rather than one filed per commit.
- **A large eval fall labels the pull request `needs:decision` and files
  nothing.** At `-n 1` there is no threshold that means significant: the same
  skill text scored 3/3 and 0/3 on two scenarios of a single run. The label
  asks a person to look, which is what the label is for. See **Making a run shorter** below for what the time is actually made of;
`bun scripts/skill-evals.ts plan` prints what a run right now would pay for
before you submit one. The loop is three steps, and
`.github/workflows/skill-eval.yml` runs all three on a pull request that touches
`.claude/skills/`:

1. **`tessl review run quality .claude/skills/<name>`** — deterministic, cached,
   no agent solve. This is the gate: it fails the check. In CI it is
   `tesslio/skill-review`, which reviews only the `SKILL.md` files the diff
   touched and comments the scores.
2. **A narrowed eval.** `scripts/skill-evals.ts changed --base <ref>` names the
   skills the branch touched, `subset` copies just their scenarios into a
   directory, and the run is
   `tessl eval run <dir> --context .claude --skip-baseline -n 1`.
   `--skip-baseline` because the baseline cannot move when only a skill changed
   and it is half the solves; `-n 1` because this is the inner loop.
3. **`compare`** against `scores.json`, posted as a pull-request comment, and
   `record` to write the new numbers back to the branch.

Three things that loop gets right, each of which took a wrong run to learn:

- **It never fails the check on a score.** At `-n 1` a scenario moves further
  between identical runs than most real regressions do. The table is for a
  person to read; the gate is step 1.
- **A score is only comparable to a score of the same fixture.** `scores.json`
  carries a hash of each scenario's `scenario.json`, `task.md`, `criteria.json`
  and `setup.sh` — everything except the skill. Edit the skill and the hash
  holds, so the delta means something; edit the scenario and `compare` prints
  *history void* rather than reading a fixture change as a regression. It does
  the same across a change of agent, model or `-n`, which is why the model is
  recorded rather than pinned: `--model` needs a paid plan, and a silent default
  change would move every number with nothing to blame.
- **`status` is not the finish line.** `tessl eval run` returns the moment a run
  is queued, and `tessl eval view --json` has reported `"status": "pending"` for
  over an hour after every solution was scored. Polling on that field hangs a job
  until its timeout. `skill-evals.ts ready` asks the answerable question instead:
  has every expected variant of every scenario been scored — and, since run 7,
  has every one of its `runCount` runs been scored.

- **A rubric is not a finish line.** A solution grows its `assessmentResults`
  array as soon as its *first* run is judged, so the obvious readiness test —
  "does every variant carry a score" — is satisfied while a three-run scenario
  has two runs still going. Run 7 passed it 54 minutes in with 17 of 20
  solutions on one scored run of three, and the table it produced put single
  samples under an `n=3` heading. The `runs[]` array is the honest signal: a run
  that genuinely produced nothing scores `0`, so a `null` there means still
  working, never legitimately empty.

- **An unchanged run is replayed, not re-executed — every variant, not just the
  baseline.** Two `--skip-baseline -n 1` runs submitted a minute apart came back
  with byte-identical scores, the same solution ids, the same tarball keys, and
  a solution `createdAt` belonging to the previous night's `-n 3` run. Nothing
  executed; the cache returned that run's last stored sample. This is right for
  CI — a skill edit changes the context hash, so the loop re-runs what it must —
  but it means a repeat run can never serve as a variance probe, and a number
  from one is not a new measurement. Change an input or read the old run.

- **An `-n 1` payload carries neither `runCount` nor `runs[]`.** Only a
  multi-run payload has them, so a readiness test that demands them waits for a
  field that never arrives — the first inner-loop run sat through a 90-minute
  poll having finished before the poll began. `ready` treats their absence as
  "one run, and the rubric is the whole signal", and an *empty* `runs` array
  under a `runCount` of three as still working.

- **The baseline is the comparison that never goes void.** A stored score is
  comparable to a new one only while the fixture *and* the rubric that produced
  it both still ship, and this loop changes both. The baseline in the same run
  was judged on the same fixture by the same rubric by the same agent, so
  `compare` puts it in its own column and `record` stores it. It answers the
  question the scoreboard cannot when history is void: is the skill earning its
  place? A `--skip-baseline` inner-loop run trades that away deliberately, which
  is why the column reads `— (skipped)` rather than going missing.

`tesslio/skill-eval` exists and is not used here. It has no way to skip the
baseline, no way to narrow a run to the changed skill's scenarios, and its
regression gate compares against a baseline this loop deliberately does not run.
`tesslio/setup-tessl` and `tesslio/skill-review` are used, pinned to a commit —
neither is tagged, and neither is one of the well-known actions this repository
takes on a version tag.

Two consequences worth expecting. The first CI run after this lands will print
*not comparable* for every scenario, because the seeded scores came from an
`-n 3` run and the loop runs at `-n 1`. And a scenario directory must begin with
the name of the skill that owns it — that prefix is the only mapping there is,
since `scenario.json` rejects an extra field to hold one. `skill-evals.ts
check-names` fails on a scenario no skill claims, because such a scenario simply
stops running the moment CI narrows a run, and nothing else would say so.

Generated scenarios are a draft. Their rubrics do not know this repo's
conventions — the `S-`/`P-`/`C-` tiers, the public/private repo split, the
four-field finding format — so edit them before trusting a score.

## Why the fixtures look the way they do

Every scenario pins a **real commit of this repository** and builds the branch
under test in `setup.sh`. Two constraints drove that:

- **`.claude/commands` has to be removed by `setup.sh`.** Claude Code loads
  those files automatically, so a fixture that ships them hands the baseline run
  the very content it is meant to be missing, and the measured gap collapses to
  zero. See the section below — the `exclude` field does not do this for you.
- **A commit fixture has no branch to diff against.** `setup.sh` constructs one.
  It also tolerates a fixture installed without its `.git`, and folds any
  install-time drift into the base commit so it never shows up inside the branch
  diff the agent reviews.

## The judge reads files, not the conversation

The single most expensive thing to get wrong. Scoring runs against the working
directory the agent leaves behind — its diff and its files. The agent's chat
output is not available to the judge at all.

So a `task.md` that says "report your findings" scores zero on every substantive
check, whatever the agent actually said. The first run here did exactly that:
nine checks came back with variations of *"no report file was created — the text
report is inaccessible from the solution directory"*. Name a file, say it is the
only thing read, and point each checklist item at it.

The corollary: a scenario whose whole output is a judgement needs somewhere to
put it. A scenario that changes code does not — the diff is the artefact.

## The twelve scenarios

| Scenario | Skill | Ground truth |
|---|---|---|
| `prep-pr-changeset-package-name-mismatch` | `prep-pr` | A stacked branch: assuming the base is `main` pulls the parent's file and the parent's changeset into this branch's diff. Its own changeset names `osn-api`; no package.json anywhere holds that name (the real one is `@osn/api`), and `changeset version` fails in CI on exactly that. |
| `review-security-consent-cookie-rediscovery` | `review-security` | The consent framework before it was hardened, carrying two defects: a consent cookie written under a bare name with no `__Host-` prefix, and a revocation that stops further loading without tearing down what an earlier grant already mounted. Does the review rediscover them? |

| `review-security-access-token-verifier` | `review-security` | `shared/osn-auth-client` as it was first written. `setup.sh` deletes the package on `main` and restores it on the branch, so the package *is* the diff. Two defects: a `jwtVerify` with no `requiredClaims: ["exp"]`, so a token with no expiry verifies for ever, and an `issuer` attached only `if (issuer)`, so a missing config value drops the check silently. |
| `review-security-zap-chat-class-authz` | `review-security` | `zap/api` message routes. `sendMessage` and `listMessages` check membership but never `chats.class`; their `sendC2bMessage` and `listC2bMessages` siblings, 120 lines below in the same file, both open with `if (chat.class !== "c2b")`. `removeMember` in `services/chats.ts` has the same gap. The enforced sibling is the proof the check was meant to apply — a shape no single-handler read can see. |
| `review-security-consent-hardened-restraint` | `review-security` | The same consent module one fix later, with the issue numbers stripped from its comments by `setup.sh` so the code has to be read. `cookie.ts` exports `PREFIXED_CONSENT_COOKIE_NAME`, `store.ts` reloads on granted→revoked. Half the rubric's points are for **not** reporting either as missing: a review skill that pattern-matches its own examples fails this and passes the one above. |
| `prep-pr-finding-routing` | `prep-pr` | A guest-session TTL change with a correct `@cire/api` changeset, plus an untracked `review-findings.md` listing four findings that route four different ways — public repo, private tracker, `needs:decision`, and one already fixed on the branch. `xchromo/osn` is public, so a finding's title and `file:line` must not reach the PR body. The bait is that they are right there in the file. |

| `review-performance-vendor-read-round-trips` | `review-performance` | The vendor read paths. Three pairs of single-row queries issued serially — the quote handler, `getLiveListingById`, `consumeClaim` — where the second never had to wait, because the key it is issued on was in hand before the first ran; plus a claimed listing handed back by `consumeClaim`, dropped by a full page navigation and refetched by the editor. Either fix is accepted (run the pair together, or fold where one statement serves both); what is scored is the diagnosis and picking one. |
| `review-performance-entitlement-gate-fold` | `review-performance` | The organiser gates. `weddingEntitlement` issues a point lookup on a wedding the role gate in front of it has already queried. Half the rubric is the fix rather than the finding: here a fold is the right answer and running the pair together is not, because the gates are sequenced by middleware order — and the fold must not tax the many routes that mount a role gate and no entitlement gate, so the key has to be an optional parameter. Paired with the vendor scenario, the two score whether the reviewer can tell the two shapes apart. |
| `review-tests-pulse-account-cookie-credential` | `review-tests` | The `/account` routes. `resolveCaller` accepts a bearer token or a session cookie; every test sends the bearer. These are the data-subject-request handlers and the browser client has no bearer to send, so the cookie path could break with the suite green. The negative case — a cookie naming no live session — is scored separately, because the positives alone cannot tell a working lookup from one that admits everybody. |
| `review-tests-cire-consent-colocated-layout` | `review-tests` | The consent framework, in a checkout where the repository has no single test layout: `osn/*`, `pulse/*`, `zap/*` and `shared/*` use `tests/`, while `cire/invites` has no `tests/` directory at all and 69 test files sit beside their source. Four changed modules have a test beside them and `ConsentPreferences.tsx` has none anywhere. A reviewer who applies a convention without looking at disk reports four covered modules as missing and buries the one real gap, so `no_false_missing_test_findings` carries as many points as finding it. |

| `review-docs-session-ttl-page-drift` | `review-docs` | A branch cuts a value in two routes and updates the wiki page that documents it — but only two of its three mentions, leaving a table row stating the old number. It also renames a heading, breaking a same-page anchor and an inbound wikilink planted on the base. Four more pages outside the diff still carry the old value, so the review has to sweep the vault rather than the diff. One bait: an escaped pipe in a wikilink table cell is Obsidian's alias syntax, not a typo. |
| `new-feat-tracker-finding-branch` | `new-feat` | A fictional tracker finding handed to the skill as the work to start. The public repo must not gain a duplicate issue, and the branch name, the commits and the plan file must not describe the defect — this repository is public and the tracker is not. Scores the routing rule, not the code. |

The rediscovery scenarios are the pattern worth repeating: **every merged fix PR
is a free labelled example.** Pin its parent SHA, write one checklist item per
finding it fixed, and the rubric writes itself from the changeset. Two things
that pattern alone will not give you, and both are worth building by hand: a
scenario pinned *after* the fix, which is the only way to score restraint, and a
scenario whose ground truth is a process rule rather than a defect, where the
fixture can plant the exact bait the rule exists to prevent.

## The loop cannot resolve a per-scenario change, and here is the number

Four runs, and the honest summary is that **run-to-run variance is larger than
anything the skill edits have moved.** The skill's aggregate score per scenario,
across four runs at `-n 3`:

| scenario | run 7 | run 9 | run 10 | run 11 | sd | range |
|---|---|---|---|---|---|---|
| `vendor-read-round-trips` | 27 | 36 | 29 | 60 | 13.1 | 33 |
| `access-token-verifier` | 57 | 82 | 46 | 56 | 13.2 | 36 |
| `zap-chat-class-authz` | 62 | 54 | 62 | 33 | 11.6 | 29 |
| `pulse-account-cookie-credential` | 67 | 63 | 38 | 53 | 11.2 | 29 |
| `consent-cookie-rediscovery` | 53 | 74 | 79 | 61 | 10.1 | 25 |
| `entitlement-gate-fold` | 35 | 35 | 20 | 41 | 8.0 | 22 |
| `prep-pr-finding-routing` | 64 | 70 | 83 | 72 | 7.0 | 19 |
| `prep-pr-changeset` | 75 | 67 | 76 | 85 | 6.4 | 18 |
| `colocated-layout` | 72 | 63 | 61 | 71 | 4.9 | 11 |
| `consent-hardened-restraint` | 83 | 85 | 91 | 79 | 4.3 | 12 |

Mean per-scenario standard deviation: **9.0 points**, with ranges to 36. Some of
that is scenario edits between runs, but not most of it — `zap-chat-class-authz`
scored 62, 54, 62 and then 33 across runs whose rubric barely moved, and run 11
changed nothing but four sentences about headings while `vendor` went 29 to 60.

**One number does hold still.** The suite-level lift, skill minus baseline:
+10.5, +18.2, +13.5, +18.4, +23.1, +17.9, +14.2 — mean 16.5, sd 3.6. Aggregating ten scenarios
buys back the power that `-n 3` does not have per scenario. Note the baseline
has fallen and then settled: 48.1, 43.3, 42.5, 41.6, 41.8. Part of the growth in
the lift is the rubrics getting stricter, not the skill getting better, and a
lift quoted without that number beside it is misleading.

So: **quote the suite lift; do not quote a per-scenario delta.** A 10-point
per-scenario movement is one standard deviation and means nothing on its own. To
attribute a change to a single scenario you would need something closer to
`-n 10`, which is four times the cost of a full run for one tenth of the suite.

### The shape of a report is unstable within a single run

Run 14 settles an argument the earlier runs could only gesture at. `prep-pr`
produced, from **one skill text, in one run**:

- `prep-pr-changeset-package-name-mismatch` — 3/3, the judge listing all five
  sections in the right order;
- `prep-pr-finding-routing` — 0/3, a free-form body with `## Changes`,
  `## Ticket`, `## Tests` and `## Notes / follow-ups in the tracker`.

Nothing distinguishes those two scenarios in what the skill tells the agent to
write. So a shape score is not a property of the instruction: it varies scenario
to scenario and run to run, and this is the fourth different way that has been
demonstrated. Do not read a shape item as feedback on a shape instruction — not
across runs, and now not within one either.

The corollary for reviewing this suite's output: when a scenario moves by tens
of points, check whether a shape item accounts for it before believing the
analysis changed. Here it accounts for the whole of a −49.

### Four targeted instruction fixes; one landed

Runs 12 and 13 each aimed at named items diagnosed from the judge's reasoning.
The scoreboard for that effort:

| fix | item | before → after |
|---|---|---|
| Out of scope takes the issue reference only | `no_private_tracker_detail_in_public_body` | 0.17 → **0.67** |
| gate-behind-a-gate bullet, tier 1 | `finds_the_probe_and_folds_it` tier 1 | 0.67/3 → **2/3** |
| gate-behind-a-gate bullet, tier 2 (the fold itself) | same item, tier 2 | 0/2 → 0/2 |
| credential bullet rewritten as a procedure | `finds_untested_cookie_credential` | 0.58 → 1.00, still under the baseline's 1.33 |
| refetch bullet rewritten as a procedure | `finds_refetch_across_navigation` | 0.33 → 0.00 |

**The one that worked was not a rewording — it was removing a contradiction.**
Two passages of `prep-pr` disagreed, and satisfying one broke the other; the fix
deleted the conflict rather than restating the rule. The rule itself had already
been stated three times and was still being broken.

**The three that failed were all rewordings**, including two that turned a
description into a numbered procedure with a grep in it — the change that
sounds most like it should work. In each case the instruction ended up present,
correct, adjacent to the finding, and ignored: the reviews kept proposing
`Effect.all` where the skill says concurrency cannot help, and kept clearing the
credential gap on the ground that the resolver was not in the diff, which the
procedure explicitly addresses.

So the ordering to try, on the evidence: **look for a contradiction first**, and
only then reword. If two rewordings of the same instruction fail, stop — the
third will not work either, and on a suite where a scenario delta under 20
points is unreadable you are paying a run per attempt to learn nothing.

### An item can be readable even when its scenario is not

Run 12 changed two things and one of them landed, which is the first clean
attribution this loop has produced. Both were found by reading item cells and
the judge's reasoning rather than scenario totals.

**The `prep-pr` leak: fixed.** `no_private_tracker_detail_in_public_body` went
0.17 → 0.67 with the skill (baseline 0.25 → 0.33), and the judge's words are the
wording that was added: "references unfixed findings only by number and finding
ID (e.g. `xchromo/osn-tracker#601 — S-M1`)". It is a 1-point binary item, so
three samples have a standard error near 0.3 and a move of half a point is
signal. The defect was never a missing rule — it was stated three times — but a
**contradiction**: the Out of scope template asked for "what was found", which is
a description, while the section rules forbade describing a tracker finding.
Satisfying one broke the other. Look for that shape before adding a fourth
statement of a rule that is not being followed.

**The entitlement fold: half-fixed, and the half that failed is informative.**
The merged item went 1.00/8 (baseline) to 2.00/8 (skill). Tier 1 — naming both
sites — rose from 0.67/3 to 2/3, so the new gate-behind-a-gate bullet did make
the pair visible as a pair. Tier 2 stayed at 0/2 across every sample: the
reviews proposed `Effect.all` concurrency to overlap the two reads, which the
skill's own bullet now names as wrong *and explains why* (the second gate mounts
behind the first and cannot start earlier). The instruction is present, correct,
adjacent to the finding, and still loses to the model's default move of
parallelising two independent reads. That is worth knowing: **an instruction
that contradicts a strong prior needs more than a correct explanation**, and
three attempts at rewording it have now failed.

### What that says about the shape work

Writing the report skeleton to disk before reading the diff, then forbidding
the whole-file rewrite that discards it, has not moved the shape items:

| | run 7 (no skeleton) | run 9 | run 10 | run 11 (rewrite forbidden) |
|---|---|---|---|---|
| skill | 8.0 | 11.0 | 7.0 | 9.0 |
| baseline | 2.0 | 1.0 | 1.5 | 1.0 |

Every post-change value sits inside the range the pre-change series already
covered. Runs 9 and 10 shared identical skill text and differed by 4 points, so
run 11's 9.0 is a sample, not a verdict. What is real, and has been in all four
runs, is the **gap**: the skill scores five to nine times the baseline on report
shape. Something in the skill produces the shape. Nothing added since run 7 has
been shown to add to it.

The lesson is not "stop trying". It is that this loop answers "is the skill
earning its place" (yes, consistently, +15 points) and cannot answer "did this
edit help" for an edit worth less than about 20 points. Reach for the
deterministic gate — `tessl review run quality` — for the second question, and
change several things at once when you do spend a run.

## A run can end `failed` with most of its work intact

Run 9 finished as `status: failed` with 58 of its 60 solves scored. Two died,
for two different reasons, and both are worth recognising:

- `Task 'solve' failed after 3 attempts: Agent task 'solve' failed`, with
  `duration_ms: 0` on the last try. The fixture installed and `setup.sh` ran;
  the agent process itself never got going. Nothing in the scenario caused it.
- `Recipe exited with code 1` after a `solve` task that ran **73.5 minutes** and
  completed. This was attempt 7 of that run index. A solve can therefore burn
  more than an hour and still be thrown away at the end.

The scores that did land are unaffected, and the judge aggregates a solution
over the runs that scored — so the two affected cells are `n=2`, a thinner
measurement rather than an absent one. `ready` treats a terminal `status`
(`failed` or `completed`) as the end and reports which cells came up short:

```
scored: 10 scenario(s)
  thin: review-security-consent-hardened-restraint [baseline]: 2/3
  thin: review-tests-pulse-account-cookie-credential [usage-spec]: 2/3
```

Before that, `ready` waited for a score that was never coming: a failed run held
the poll open for its full timeout, and the numbers sat there unread. The lag in
`status` only ever runs one way — pending until after scoring finishes, never
back — so a terminal status is safe to trust even though a pending one means
nothing. A solution with **no** scored run at all is still not ready, because
there is nothing to average.

## Making a run shorter

Measured from `runMetadata[].metrics.jobId`, which carries each job's epoch-ms
start, and from the per-solve `runs[]` telemetry in `tessl eval view --json`.

**What the time is made of.** Agent seconds correlate with turn count at only
r = 0.31; with output tokens at r = 0.56 (run 7) and 0.69 (run 9). Generation
runs at a median 80 tokens/second in both runs, so a solve that emits 64k tokens
needs about 800 seconds simply to write them. Cost is the other way round: 54–59%
of it is cache reads, which scale with turns × context. **Output tokens drive
time; turns drive cost.**

Two consequences. Shortening a `SKILL.md` saves nothing measurable — it is 3–6k
cached tokens, pennies per solve and no wall clock. And the only edit that makes
a run faster is one that removes work the agent *performs*.

**Wall clock is the sum of the waves' maxima.** The harness launches a whole run
index at once — 17 to 20 solves — and waits for the slowest before starting the
next. Run 7's solve waves began at +0, +55 and +140 minutes, with a retry at
+231 that held the last hour by itself: 290 minutes of wall clock for 19.4
agent-hours of work. So the median solve is irrelevant to how long you wait, and
the longest one is everything. `tessl eval run` exposes no solve timeout and no
turn cap of its own, but the platform enforces one: run 10 recorded
`Task 'solve' timed out after 1800000ms`, so there is a 30-minute ceiling. Run 9
nevertheless had a solve complete at 73.5 minutes, so the ceiling is not applied
uniformly. Neither is reachable from the CLI; a settable value is worth asking
for.

**The biggest lever is not re-solving what has not changed, and it works.** Run
10 changed every scenario and executed all 60 solve jobs. Run 11 changed only
the skills, and executed **33** — 9 of its 20 solutions came back replayed from
run 10, which is what `plan` predicted (30). An unchanged scenario replays its
baseline; its `usage-spec` variant does not, because the injected context is
part of the cache key. Note that the cost totals in `tessl eval view` sum every
row including the replayed ones, so a run's reported `costUsd` is not what it
billed — count executed solve jobs instead. `bun scripts/skill-evals.ts plan` prints what a
run now would actually pay for, and warns when the skills and the scenarios have
both moved since the scoreboard — because then a scenario's baseline is being
re-judged by a new rubric in the same run, and a movement cannot be attributed
to either. **Land rubric edits on their own, then edit the skill.**

**Do not cut `-n` on the variant under test.** The obvious saving is to drop
low-variance scenarios to one sample, and the per-scenario spread from run 7 says
where that would bite:

| scenario | baseline scores | sd | usage-spec scores | sd |
|---|---|---|---|---|
| `consent-hardened-restraint` | 83, 83, 83 | 0.0 | 83, 66, 100 | 13.9 |
| `pulse-account-cookie-credential` | 50, 50, 50 | 0.0 | 68, 75, 56 | 7.8 |
| `consent-cookie-rediscovery` | 40, 46, 46 | 2.8 | 0, 66, 93 | 39.1 |
| `vendor-read-round-trips` | 26, 20, 26 | 2.8 | 40, 20, 20 | 9.4 |
| `colocated-layout` | 66, 61, 55 | 4.5 | 55, 61, 100 | 19.9 |
| `entitlement-gate-fold` | 38, 27, 22 | 6.7 | 38, 22, 44 | 9.3 |
| `zap-chat-class-authz` | 57, 35, 35 | 10.4 | 71, 28, 85 | 24.3 |
| `access-token-verifier` | 42, 57, 42 | 7.1 | 42, 71, 57 | 11.8 |
| `prep-pr-finding-routing` | 38, 84, 38 | 21.7 | 53, 76, 61 | 9.5 |
| `prep-pr-changeset` | 83, 33, 41 | 21.9 | 91, 100, 33 | 29.7 |

The baselines are the stable half; **the `usage-spec` variant is the noisy one
almost everywhere**, and it is the one being measured. The restraint scenario
looks like the safest candidate on its baseline alone (sd 0.0) and is one of the
worst on the variant that matters (83/66/100). So there is no scenario here where
one sample would be honest. The saving has to come from replay and from fixture
size, not from `-n`.

**Trim a fixture to what the rubric scores.** Both review skills require every
changed file to be read in full and given a `## Coverage` line, so a test file in
the diff is mandated reading that no checklist item scores. Two fixtures now keep
their tests on the base branch, where they can still be read: the zap scenario
(three test files, 1771 of 3196 lines) and the consent-rediscovery scenario (five
test files, 1117 of 2544 lines). The hardened-restraint fixture keeps its tests
in the diff on purpose — its rubric and its `setup.sh` both target them.

**Ask for what the rubric wants.** A `task.md` that says "review the branch to
whatever standard this repository holds" invites a security, performance, tests
and changeset pass, then scores one of them. Narrowing the two performance tasks
to "performance-review" cut the vendor scenario's `usage-spec` solve from 2743 to
687 seconds while its baseline did not move. The security and prep-pr tasks are
narrowed the same way, and the prep-pr fixtures now say the reviews have already
run — `prep-pr`'s Steps 4 and 6 otherwise dispatch three review subagents whose
output no prep-pr rubric scores.

## When to retire a scenario

`review-deps-planted-drift-no-registry` was written, run once, and removed. It
is worth recording why, because the test generalises.

Its rubric asserted "there is no network, so no latest version or publish date
could have been obtained", and both variants returned a report claiming the
registry **was** reachable, with dated version data for about fifty packages.
Either the agents fabricated all of it, or the sandbox has egress and the task's
own premise — which the task only *asserts*, it does not enforce — is false. From
outside the sandbox those two cannot be told apart, and the scenario's largest
item hangs on which is true.

**A scenario has to be verifiable from the fixture tree.** Every other one here
is: the defect is in a file at a commit, and the rubric can be checked by
reading it. This one's ground truth was a claim about the runtime environment,
and its correctness depended on a fact nobody in the loop can observe. That is
the disqualifying property, not the low lift.

Two other signals pointed the same way, and both are worth checking on any
scenario that is not discriminating:

- **Its baseline was wilder than its skill.** Baseline samples 92, 50, 42
  against 57, 64, 64 for the skill. A no-skill variant swinging fifty points is
  a scenario measuring its own noise.
- **Two of its seven items were free.** `finds_every_range_disagreement` (3 pts)
  and `aligns_to_the_highest_range_already_declared` (2 pts) were full marks for
  both variants: comparing four version ranges across `package.json` files is
  not something a skill has to teach.

`review-deps` keeps its skill and its deterministic quality gate. Not every
skill needs a scenario, and one whose whole job is asking a registry what is
published is a poor fit for a sandbox that may or may not have a registry.

## Keep provenance out of the scenario

A scenario should carry the least it needs, and a pull-request number is never
part of that. The judge reads `criteria.json` and cannot check `#849` against
anything; the agent reads `task.md` and must not be told which review this is a
rediscovery of. Both were full of it — "the fix that landed later as #852",
"osn-tracker#163, filed S-L1", "the commit immediately before #782". None of it
survives.

What replaces it is the fact itself, stated so it can be checked against the
tree: not "the fix ran each pair through `Effect.all`" but "the key the second
query is issued on was in hand before the first ran". Product names go the same
way wherever a path already carries them — `cire/api/src/...` says which
service it is, so "the cire vendor read paths" is just "the vendor read paths".
The branch names stay, because the agent has to diff them.

**`setup.sh` gets the same treatment, and for a sharper reason.** Its header
comments used to explain what was wrong with the code and why, which is the
answer written out in prose — and the script runs *inside the checkout the
agent then reviews*. Whether the harness leaves it on disk is not something to
rely on either way. Every header is now mechanics only, ending with a line
saying the ground truth is in `criteria.json` and deliberately not repeated.

The provenance is worth keeping; it just belongs to the maintainer, not the
scenario. It lives here:

| Scenario | Fixture | Came from |
|---|---|---|
| `prep-pr-changeset-package-name-mismatch` | constructed | no upstream PR — the stacked base and the bad package name are planted |
| `prep-pr-finding-routing` | constructed | no upstream PR — `review-findings.md` is planted |
| `review-security-consent-cookie-rediscovery` | `4a31cbca` | parent of #851; findings osn-tracker#163, #162 |
| `review-security-consent-hardened-restraint` | `8b55084a` | the same module after #851 |
| `review-security-access-token-verifier` | `d45562ef` | osn-tracker#507 (fixed in #782), osn-tracker#177 (fixed in #839) |
| `review-security-zap-chat-class-authz` | `5231a25b` | parent of #841 |
| `review-performance-vendor-read-round-trips` | `fcf34fcc` | parent of #849 |
| `review-performance-entitlement-gate-fold` | `6168009c` | parent of #852 |
| `review-tests-pulse-account-cookie-credential` | `a381059a` | parent of #843 |
| `review-tests-cire-consent-colocated-layout` | `6168009c` | layout predates #867 |
| `review-docs-session-ttl-page-drift` | `981ea544` | constructed — reuses the TTL change from the prep-pr fixture, plants the anchor link |
| `new-feat-tracker-finding-branch` | `6168009c` | parent of #852, shared with the entitlement scenario; the tracker issue is invented |

## Write the rubric from the tree, not from the pull request

The ground truth in `criteria.json` describes files the judge can open. Write it
by reading them, at the fixture commit, after running `setup.sh` — never from
memory of the change it came from.

Two errors this catches, both real. The colocated-layout rubric said the branch
changed "five source files" and that "four have a co-located test file", which
listed three; it had been written from the shape of the module rather than from
the eight paths its `setup.sh` actually moves. And the subprocessors item asked
the review to say a vendor row must be *added* to the compliance register, when
both vendors already had rows at the fixture commit and what was open was their
agreement and transfer-basis cells — so the item was aimed at a fact that is not
true, and a correct report could not earn it.

The check is one command per scenario, and it is worth running whenever a
rubric changes:

```bash
git archive <fixture-ref> | tar -x -C /tmp/sc && cp <scenario>/setup.sh /tmp/sc/
cd /tmp/sc && bash setup.sh && git diff --name-only main...HEAD
```

Every file that list prints is a file `## Coverage` has to account for, and
anything the rubric names that is *not* on it is context the agent reads from
the base branch — legitimate, but say so in the rubric rather than implying it
is part of the diff.

## What the score actually measures

Not "does the agent know this?" but **what does the skill add on top of
everything already in the repository.** The baseline run is not an ignorant
agent: it gets `CLAUDE.md`, the whole `wiki/`, and every committed script,
including the ones that answer the question outright. `scripts/validate-changesets.sh`
is a working oracle for the changeset scenario, and `CLAUDE.md` names the exact
trap the fixture plants.

That is the honest question to ask of a skill, and it has one hard consequence:
**a checklist item only discriminates if it points at something the skill says
and nothing else in the repository does.** Before weighting an item, grep the
tree at the fixture's own commit for the fact it tests. If a committed file
already states it, the item measures the repository, and both variants will
score it full marks.

The corollary bit twice. Two 3-point items in the review rubric aimed at cookie
integrity, which the review skill had no section on at all — so they scored the
model rather than the skill, and the fix was to write the missing section into
`review-security/SKILL.md`. An eval that finds a hole in the skill has done its
job; it just cannot also measure that hole in the same run.

## The rubric must not contradict the skill

A `no_filler_findings` item docked the with-skill run for reporting an
accessibility issue — which the skill's EAA section requires it to report. The
skill was steering exactly as designed and the rubric punished it for it. Any
item that penalises breadth needs to name what counts as filler *in this
repository's terms*, or it will fight the very behaviour under test.

Likewise, an item must not pay out when its parent fails. `notes_http_dev_fallback`
scored full marks in runs where the cookie finding it depends on was absent
altogether. A dependent point belongs inside its parent item as one of the
things worth marks, never as an item of its own.

## Free points shrink every lift you measure

Each scenario used to carry two one-point guards — "edited nothing" and
"claimed no remote action" — and both variants scored both, in nearly every run
of every scenario. Twenty points across the suite that neither run could lose
sat in the denominator, pushing both percentages up and the gap between them
down. They are still worth checking, because a run that fabricates a green test
suite has failed whatever else it did; they are not worth two separate items.
They are now one `stayed_within_the_brief` item per scenario, scored 1 only if
both halves hold.

The same audit is worth running on any item that reads full marks for both
variants across a whole run: either it measures the repository rather than the
skill (see above), or it is a guard nothing plausibly trips, and in both cases
its weight is diluting the number you actually care about.

## Never put a variant marker in the file the judge reads

A comment identifying which skill produced a report — `<!-- generated by … -->`
at the top of the skeleton — would let a run be traced back to whether the skill
was in view, which `activatedSkills` does not reliably answer (it comes back
empty in nearly every solution). It is also the one thing that must not be
there. The judge reads the file, the marker appears in one variant only, and
scoring stops being blind. The traceability is not worth an unblinded rubric.
Note that `tessl eval run` forces context activation unless
`--skip-forced-context-activation` is passed, so an empty `activatedSkills` is
better read as a reporting gap than as the skill having been ignored.

## Write the report skeleton first, not last

The most consistent failure across the whole suite was report shape, not
analysis: `report_shape_coverage_and_sections` scored 0 out of 2 for the
baseline in six of seven review scenarios, and the skill runs topped out at 1.67.
The skills all specified the shape and specified it twice — once up front and
once at the end — and runs still finished with a `## Summary` heading that is
not allowed, or a section missing.

Stating a rule harder does not fix it, because the failure is not
comprehension. It is that the file gets written at the end of a long run, from
memory, under whatever structure the analysis happened to take. So the skills
now open with a **Step 0 that writes the skeleton to disk before the diff is
read** — every heading, in order, each holding `None`. The rest of the run
replaces placeholders. Nothing about the shape depends on remembering it an
hour later.

## Harness artefacts score against the skill variant

Tessl injects the plugin into the with-context run as symlinks under `.claude/`
and `.agents/`. They are working-tree changes, they exist in that variant only,
and a "did not modify the repository" check reads them as the agent's edits —
a silent handicap on precisely the run being measured. Every `setup.sh`
writes those paths into `.git/info/exclude`, and every rubric tells the judge to
ignore them explicitly. Belt and braces, because either alone has failed.

## The fixture repo ships the skills, so setup.sh has to delete them

`.claude/commands/prep-pr.md` and `.claude/commands/review-security.md` were
tracked in the OSN repo, and their content was the same content as the skills
under test. Any fixture pinned at a real commit therefore installs a full copy
of the answer into the baseline's working directory. Both files have since been
deleted, but a fixture pins a commit, not `HEAD`, and every scenario here pins a
commit from before the deletion — so the copies still arrive and the `rm` still
has work to do. Keep it in any new scenario too: the next skill to be converted
will leave the same trail behind it.

`"exclude": [".claude"]` in `scenario.json` is a documented fixture field, but
it does not remove them — run 4 proved it, and the field has since been dropped
from every scenario here so that nothing reads as protection it does not give.
The baseline scored 3/3 on
`pr_body_five_sections`, reproducing `## Summary`, `## Workspaces affected`,
`## Issues`, `## Decisions` and `## Test plan` in that exact order, which is
not something an agent invents. Every cross-variant number from runs 2 to 4 is
void because of it.

Every `setup.sh` now opens with `set -euo pipefail` and:

```bash
rm -rf .claude/commands .claude/projects .claude/evals .claude/tessl.json
```

`.claude/skills` is deliberately absent from that list: it is what the plugin
variant injects. `.claude/evals` is on it because the plugin ships the rubric
alongside the skills, and a `criteria.json` in the working directory is the
checklist handed straight to the agent.

The general rule: before pinning a fixture commit, `git grep` that commit for
any distinctive string the rubric rewards. If the repo answers it, either the
scenario cannot measure it or `setup.sh` must remove the answer.

**That includes the source's own comments.** The hardened-consent fixture is a
module whose comments cite the two filed issues by number — "This is
osn-tracker#163" — and name three `describe` blocks after them. The scenario
asks whether a reviewer can tell a fixed defect from a live one; a comment
saying "this was osn-tracker#163" answers it in prose, and both variants scored
near-perfect on the two restraint items as a result. `setup.sh` now strips the
issue references and nothing else: comment lines that name one go whole, a
reference inside a string literal loses only the parenthetical, the reasoning
around them stays, and the code is untouched. Grep a candidate fixture for
issue numbers, `FIXME`, `TODO(<id>)` and "was a bug" before trusting it.

## The baseline variant is cached across runs

A second `tessl eval run` on the same scenario replays the previous baseline solution instead of re-solving it — same score, same duration, same token counts, to the byte. Only the with-context variant re-runs, and the run costs half the credits. That is what you want while iterating on a skill, but it has one trap: **a change to `setup.sh`, `task.md` or the fixture invalidates the baseline and nothing tells you so.** After changing anything outside `skills/`, treat the baseline column as stale until you have seen it move.

## Writing a scenario that can discriminate

Three ways a scenario scores well and measures nothing, all three hit on the way
here:

- **The task leaks the checklist.** The first draft told the agent to "check
  that the changeset is one CI will accept". The baseline scored 100% — it was
  reading the answer out of the task, not out of the skill. State the goal
  ("prepare this branch for a pull request") and let the skill supply the steps.
  The leak is easy to reintroduce: a "Context you need" section that sets up
  both ground truths hands over the findings, and spelling out the finding
  format makes the format item free on both variants.
- **The rubric aims at what the repository already answers.** See above. This is
  the one that survives the obvious fixes, because a leak-free task and a real
  fixture still produce a flat result if every point is common knowledge in the
  tree.
- **`-n 3` is the floor for a headline, and it is not enough for a small
  number.** Run 7's ten scenarios at `-n 3` put the skill 10.4 points ahead of
  its own baseline overall, but three of those scenarios moved by under two
  points — inside the spread of three samples. Quote the suite total from `-n 3`;
  quote a per-scenario lift only when it is comfortably into double figures, and
  raise to `-n 5` before claiming anything about the small ones.
- **One run is noise.** At `-n 1` the review scenario found one of its two
  findings in the baseline and the *other* one with the skill, for identical
  totals. At `-n 3` the with-skill total on that scenario swung from 56% to 87%
  between runs. Read a gap smaller than that spread as nothing at all; `-n 5` is
  the floor for a number worth quoting.

Note what `-n 3` does and does not give you. The table shows the mean; per-run
scores are in `--json` under `solutions[].runs[]`. The judge's *reasoning*,
though, is written once per check per variant, not once per run — so a mean of
0.33 tells you the runs disagreed and gives you nothing to diagnose it with.

A scenario earns its place when doing the task the obvious way gets it wrong.
The stacked branch is the shape to copy: assuming `main` is the base is not
merely unrewarded, it produces a diff and a changeset verdict that are both
wrong.

## Keep the fixture internally consistent

An agent that spots a fixture as a fixture stops reviewing and starts guessing
at the exercise. Three things kept the branches ordinary:

- the branch's diff is a real change to the constant its commit message and
  changeset both describe, not a comment appended to an unrelated file
- the planted wrong package name is `osn-api`, which exists nowhere, rather than
  `osn`, which is the root `package.json`'s real name and gave a sharp agent
  something true to argue about
- `origin` points at the repository itself, so the skill's opening
  `git fetch origin "$BASE"` succeeds instead of burning turns on a network
  error the task then has to explain away

The review scenario also carries one deliberate piece of bait: the branch bumps
a caret-ranged dependency. Reporting a caret range as a supply-chain finding is
a false positive this repo has a real control for (`minimumReleaseAge` in
`bunfig.toml`), and an item scores the reviewer for knowing the difference.

## CI

Not wired up yet — it needs a `TESSL_TOKEN` secret and a workspace, and each run
costs a doubled agent run per scenario. When both exist, drop this in at
`.github/workflows/skill-eval.yml`:

```yaml
name: Tessl Skill Eval
on:
  pull_request:
    paths: ["**/SKILL.md", "**/evals/**"]
  issue_comment:
    types: [created]

jobs:
  eval:
    if: github.event_name == 'pull_request' || github.event.issue.pull_request
    runs-on: ubuntu-latest
    timeout-minutes: 120
    permissions: { contents: write, issues: write, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
      - uses: tesslio/skill-eval@main
        with:
          eval-workspace: <workspace>
          tessl-token: ${{ secrets.TESSL_TOKEN }}
```

Then `/tessl scenarios .claude` and `/tessl eval .claude` work as PR comments.
Budget 120 minutes for the job: generation and evaluation each get their own
timeout.
