---
name: pick-agent
description: Use when dispatching a subagent and choosing which one — mapping a task and its declared complexity to an agent definition, and so to a model and an effort level. Invoked by orchestrate when it hands off a task; also the answer to "should this run on a cheaper model".
---

Choose the agent definition for `$ARGUMENTS`. If it is empty, ask what the task
is and what its issue's `complexity:` label says.

## What this run must produce

One name from `.claude/agents/`, and one sentence saying why. Not a paragraph
weighing the options — the caller is about to dispatch and wants a decision.

If the task does not fit any definition, say so and default to `implementer`.
Defaulting up is cheap and recoverable; defaulting down produces a subagent that
quietly does a worse job and reports success.

## Read this before you trust the rubric below

**There is no evidence behind the effort levels yet.** Across every transcript
in this repository, 64,491 assistant records carry an `effort` field and every
single one of them reads `high`. A further 6,561 — 9% — carry no `effort` field
at all, and nothing can be said about those; the count is of records that
report, not of every record. Either way nothing here has ever *reported*
running at `low`, `medium`, `xhigh` or `max`, so no measurement can say what
those settings are worth on this codebase.

The 9% matters beyond pedantry: a card whose `spend.effort` map is empty is
missing the field, not running at zero effort. Seventeen of the first
thirty-four cards are in that state.

The rubric is therefore reasoning, not data. It comes from the documented
behaviour of the levels and from what the session cards show tasks actually
cost, and it will be wrong in places. Two consequences:

- **Say when you are guessing.** A caller that knows the recommendation is a
  prior treats it differently from one that thinks it is a measurement.
- **This skill creates the evidence that will correct it.** Every card records
  `spend.effort` and `spend.by_model`. Once dispatches start varying, run
  `analyse-sessions` and let it argue with what is written here. Expect that to
  happen; the numbers below are a starting position, not a settlement.

## The rubric

Match on what the task *demands*, never on how large the diff will be. A
one-line fix to a race condition is not mechanical work.

| Definition | model · effort | Give it |
|---|---|---|
| `implementer` | opus · xhigh | Anything that designs something. New behaviour, a schema change, a major version bump, auth or session work, a bug whose cause is unknown. The default. |
| `mechanic` | sonnet · medium | Work whose answer is fixed before it starts: patch and minor dependency sweeps, renames, changesets, a known pattern applied across files. |
| `explorer` | sonnet · low | Read-only orientation. Returns `file:line`, proposes nothing. |
| `shepherd` | haiku · low | Polling a pull request to a terminal state. |
| `attacker` | fable · high | Attacking a plan, cold. A different model on purpose. |

Where the issue carries a **confirmed** `complexity:` label, use it — it was set
before work started, which is exactly why it is worth something:

| Declared | Usually |
|---|---|
| 1–2 | `mechanic`, unless the cause is unknown or a version bump crosses a major |
| 3 | `implementer` |
| 5–8 | `implementer`, and consider splitting the task before dispatching at all |

Two things about that table before you lean on it.

**Ignore a rating carrying `complexity:unconfirmed`.** That label means an agent
rated the issue and no human signed off, which is every rating `rate-complexity`
produces in its backfill mode. `report.ts` excludes unconfirmed ratings from
three of its seven analyses on the grounds that "acting on an agent's own guess
about difficulty is what would make this circular" — and a dispatch is the most
consequential thing anyone acts on. Treat an unconfirmed rating as no rating.

**Today the table never fires.** No issue in `xchromo/osn` carries a
`complexity:` label yet; the labels exist and nothing wears one. So in practice
you are choosing from the task text, and the rubric above is the whole input.
Say so when you do.

## Four traps

**A small change is not a mechanical change.** The `mechanic` definition exists
for work where the answer is already decided. A major version bump produces two
changed lines and needs every breaking change read and applied deliberately —
that is an `implementer`. Nine of the twelve dependency pull requests in this
repository's history contained a major bump, and the cheap ones were cheap
because they were isolated, not because they were mechanical.

**Check the semver delta before you choose, do not infer it.** The rule above
only helps if you know the bump is a major, and a dispatch happens before any
diff exists — so read the manifest and the target version rather than trusting
the issue's framing:

```bash
grep -n '"<package>"' <workspace>/package.json    # what is declared now
```

A jump in the leading number sends it to `implementer` whatever the label says.
The corpus warns in both directions: the isolated major bumps here each cost
under $6, while a 21-package *patch and minor* advisory sweep cost $41.70 over
seven sessions. Breadth is its own kind of hard, so a wide sweep is not
automatically `mechanic` either.

**Never choose by cost.** The question is what the task needs, not what it would
be nice to pay. A cheaper agent that does the job worse costs more, because the
work comes back. Downgrade only where the task genuinely does not need the
capability — which the rubric above is an attempt to name.

**One task, one agent.** Two agents writing code in the same worktree corrupt
each other's branches. If work must run in parallel, give each its own worktree
— `CLAUDE.md` says so and it has already cost this repository a lost task.

## What consumes this

`orchestrate` Step 3 — the task hand-off, and the one dispatch site that asks
this skill. Its other three are fixed by role rather than chosen: Step 4
dispatches `implementer` fix subagents, Step 5 dispatches `shepherd` to poll,
and Step 1 still uses the built-in `Explore` agent. `stress-plan` names
`attacker` directly and does not consult this skill either. Worth stating
plainly so nobody assumes a reach this does not have.

The definitions themselves are `.claude/agents/*.md`, and their frontmatter is
the only place per-task effort can be set — the dispatch call carries `model`
but has no `effort` parameter, so a definition is not a convenience here, it is
the mechanism.
