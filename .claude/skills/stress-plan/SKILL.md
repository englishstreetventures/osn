---
name: stress-plan
description: Use when an implementation plan has just been written and before any code is written — hands the plan to a second model in a fresh context to attack it, then requires every finding to be closed or rejected in writing. Invoked by new-feat at the end of its planning step and by orchestrate once per phase, and worth running on its own for any plan whose assumptions have not been checked against the code.
---

Attack the plan for `$ARGUMENTS` before anything is built on it. If `$ARGUMENTS`
is empty, ask for the plan file's path.

The plan is the one artefact every later step inherits. A wrong assumption in it
is copied faithfully by whoever writes the code, and comes back as a clean diff
doing the wrong thing — green gates, passing tests, no behaviour change. No
review downstream catches that, because every downstream review checks the work
against the plan rather than the plan against the repo.

## What this run must produce

1. A findings file at the path the plan names, or `PLAN-REVIEW.md` beside the plan.
2. Every finding **closed**: fixed in the plan, or rejected with the reason written
   into the plan itself.
3. A one-line verdict in the final message: how many findings, how many fixed, how
   many rejected and why.

**No implementation starts while a finding is open.** Silence is not a rejection.

## Step 0 — Is this plan worth attacking?

**Skip** a mechanical change inside one package that creates no file, adds no
dependency and touches no schema: a rename, a config flag on a value the plan has
already traced to its reader, a test for behaviour that already exists. There the
plan is short enough that a wrong assumption shows up as a failing gate rather
than as a clean diff.

**Never skip** for:

- a **defect class** rather than a list of sites — "fix every place that does X" —
  however mechanical each fix looks. What a plan gets wrong there is the boundary
  of the class, and no gate can fail on a site nobody found. A batch that passed
  every skip test above (one package, no new files, no schema) went to this stage
  anyway and came back with two more instances, one of them a GDPR erasure path
  that could never complete.
- anything touching auth, tokens, sessions, a D1 schema, a Worker binding, or a
  build config another package inherits
- more than one package, a new dependency, or a new file

When in doubt it runs. The stage costs one round trip; the failure it catches
costs the branch.

## Step 1 — Make the plan attackable

The plan must be a file on disk, because the attacker gets a fresh context and
reads it cold. `new-feat` writes `NEW-FEAT.md`; `orchestrate` uses the phase's
plan under `docs/superpowers/plans/`. Either is fine — pass the path.

Before dispatching, check the plan carries the three things this stage most often
finds missing. Each is cheap to add now and expensive to discover later:

- **Every config value the plan says to set names the file and line that reads
  it.** No citation means the instruction is a guess. This is the single most
  productive check in the stage: a plan once said to set
  `vite: { build: { minify: true } }`, the framework hard-set `minify: false`
  after reading it, and the whole task shipped as a no-op that passed every gate.
  A value read in **more than one** place is a second finding, not the same one —
  the same plan's `sourcemap: true` was also read by the client build, which would
  have published the app's source maps to a public directory.
- **A build-config change names the directories the build writes**, and which of
  them are served publicly. "The build passes" is not the same as "the output is
  what I expected".
- **The issue's premise, verified.** An issue written weeks ago states what was
  true then. Check the sentence the work rests on before the plan inherits it: an
  issue reading "only one of six apps has a guard" implied five apps of the same
  shape, and five of the six turned out to be a different shape entirely.

## Step 2 — Dispatch the attacker

One `general-purpose` agent, **`model: "fable"`** where it is available and
another model otherwise. A different model reading cold is the point: it does not
inherit your reasoning and cannot agree with you out of habit. Never continue your
own session for this, and never dispatch the agent that wrote the plan.

The prompt, adapted to the plan's path:

> Read `<plan path>`. Attack it. You are not here to improve the wording.
>
> Report:
> - wrong assumptions about how this repository works
> - dependencies missing from the task list, or steps in an order that cannot work
> - any step whose stated definition of done does not prove the goal — especially
>   a command that would not actually run the thing it claims to test
> - paths, symbols, scripts or package names the plan names that do not exist
> - any config value the plan sets whose reader the plan does not cite, and any it
>   cites that is read somewhere else as well
> - anything the plan calls easy that is an auth, schema, binding, migration or
>   build-config problem in disguise
> - the premise the plan inherited from its issue, if it is no longer true
>
> Cite a file and line for every claim. Do not edit any file, do not run a build,
> and do not write code. Write `<findings path>` and reply with the path only.

Give it the worktree path and the branch, tell it the repository conventions live
in `CLAUDE.md` and the wiki, and tell it explicitly not to build — a reviewer that
builds in a worktree another process is building in produces measurements that are
not real.

## Step 3 — Close every finding

Read the findings yourself and act on each one. Three outcomes and no fourth:

- **Fix the plan.** The usual case.
- **Reject it, in writing, in the plan.** One line: what was claimed and why it is
  wrong. A rejection you did not write down is indistinguishable from a finding
  you missed, three steps later when it turns out to matter.
- **Escalate it** when it needs a decision only the repo owner can make — label the
  issue `needs:decision`, write the body so they can decide from the issue alone,
  and carry on with the rest of the plan.

Reject with evidence, not with confidence. A rejected finding on this repo turned
out to be a reviewer measuring a build directory two processes had written into at
once; the tell was a file count that disagreed with what the app emits. Check the
claim's numbers against the artefact before you either accept or dismiss it.

## Step 4 — Re-run, or don't

Re-run this stage when the plan **changes shape** — a new step, a re-cut
dependency, a different approach. Not for wording, and not for closing the
findings it just produced.

## Finish

Report the count, what was fixed, what was rejected and why, and that the plan is
now clear to build. Then continue with the skill that called this one.

Two things worth carrying into the run that follows, both of which this stage
tends to surface:

- **A guard, check or budget the plan adds is not verified until it has been seen
  to fail.** Break the input, watch the non-zero exit. A check that only ever
  passes is indistinguishable from one that cannot fail.
- **Count where findings came from** — the plan, the brief, or the implementation.
  It is the only signal that says which stage to spend more on, and it is usually
  not flattering to the planner.
