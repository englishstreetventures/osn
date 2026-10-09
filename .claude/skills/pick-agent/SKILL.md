---
name: pick-agent
description: Use when dispatching a subagent and choosing which one — mapping a task and its declared complexity to an agent definition, and so to a model and an effort level. Invoked by orchestrate when it hands off a task; also the answer to "should this run on a cheaper model" and "is general-purpose right here".
---

Choose the agent definition for `$ARGUMENTS`. If it is empty, ask what the task
is and what its issue's `complexity:` label says.

## What this run must produce

One name from `.claude/agents/`, and one sentence saying why. Not a paragraph
weighing the options — the caller is about to dispatch and wants a decision.

If the task does not fit any definition, say so and default to `implementer`.
Defaulting up is cheap and recoverable; defaulting down produces a subagent that
quietly does a worse job and reports success.

## The rubric

Match on what the task *demands*, never on how large the diff will be. A
one-line fix to a race condition is not mechanical work.

Each definition's model and effort live in the `model:` and `effort:` lines of
its file under `.claude/agents/`. Read the file of the one you choose rather
than assuming either, and name both in your sentence.

| Definition | Give it |
|---|---|
| `implementer` | Anything that designs something. New behaviour, a schema change, a major version bump, auth or session work, a bug whose cause is unknown. The default. |
| `mechanic` | Work whose answer is fixed before it starts: patch and minor dependency sweeps, renames, changesets, a known pattern applied across files. |
| `reviewer` | Reviewing a branch through one lens — `review-tests`, `review-security`, `review-performance`, `review-docs`, or a whole branch against its plan. Reports findings; fixes nothing. |
| `explorer` | Read-only orientation. Returns `file:line`, proposes nothing. |
| `shepherd` | Polling a pull request to a terminal state. |
| `attacker` | Attacking a plan, cold, in a fresh context. |

Where the issue carries a **confirmed** `complexity:` label, use it — it was set
before work started, which is exactly why it is worth something:

| Declared | Usually |
|---|---|
| 1–2 | `mechanic`, unless the cause is unknown or a version bump crosses a major |
| 3 | `implementer` |
| 5–8 | `implementer`, and consider splitting the task before dispatching at all |

**Ignore a rating carrying `complexity:unconfirmed`.** That label means an agent
rated the issue and no human signed off. The session-metrics
tooling leaves unconfirmed ratings out so its charts cannot be circular
(`tools/metrics/src/shape.ts:134`) — and a dispatch is the most
consequential thing anyone acts on. Treat an unconfirmed rating as no rating,
and say you chose from the task text alone.

## Never `general-purpose` for work a definition covers

`general-purpose` runs on its parent's model at its parent's effort. A review
sent from an `implementer` therefore runs at the implementer's settings because
of who sent it, not because anyone chose them, and it carries none of the
definition's rules — `reviewer`'s ban on changing the checkout, for one.

Review, plan-attack and whole-task work always go to their definition. Over
September and October 2026, about half of all dispatches in this repository went
to `general-purpose`, most of them `prep-pr` reviews, with plan attacks and
whole-task hand-offs making up most of the rest; `analyse-sessions` gives the
current split. `general-purpose` is right only for one-off research, a probe of
the harness, or a skill's own eval run — work no definition describes.

A plugin skill's dispatch template is not a licence either.
`superpowers:subagent-driven-development` hard-codes `general-purpose` and picks
a model per task. Send an implementer prompt it would put on its cheapest tier —
the plan holds the complete code — to `mechanic`, every other implementer prompt
to `implementer`, and its final whole-branch review to `reviewer`, none with a
`model`. Its per-task reviews and re-reviews are the one exception: they keep
the plugin's own `general-purpose` dispatch and model choice, because routing
each of them to `reviewer` would run every small review at `xhigh`.

## Pass no `model` and no `effort`

A dispatch to one of these definitions passes neither. A `model` on the Agent
call overrides the definition's `model:`, and the transcripts show it happening —
`attacker` sent with another model, `mechanic` sent with `opus` — each one a
silent departure from the setting the definition records. The Agent tool also
takes `effort`, but a value there is the same kind of override; change the
definition instead, so every dispatch picks the change up.

Frontmatter `effort` overrides the session's effort level, but not the
`CLAUDE_CODE_EFFORT_LEVEL` environment variable
(`code.claude.com/docs/en/sub-agents`).

## How much the effort levels are worth here is not measured

Session cards now record dispatches at every level from `low` to `xhigh`, so the
data to compare them exists. Nobody has yet compared outcome against effort on
this codebase, so the levels in the definitions are reasoned defaults, not
measured optima. Two consequences:

- **Say when you are guessing.** A caller that knows the recommendation is a
  prior treats it differently from one that thinks it is a measurement.
- **Let the data argue.** Every card records `spend.effort` and `spend.by_model`.
  Run `analyse-sessions` before changing a definition, and let it argue with
  what is written here.

A card whose `spend.effort` map is empty is missing the field, not running at
zero effort.

## Four traps

**A small change is not a mechanical change.** The `mechanic` definition exists
for work where the answer is already decided. A major version bump produces two
changed lines and needs every breaking change read and applied deliberately —
that is an `implementer`. Most of the dependency pull requests in this
repository's history contained a major bump, and the cheap ones were cheap
because they were isolated, not because they were mechanical.

**Check the semver delta before you choose, do not infer it.** Read the manifest
and the target version rather than trusting the issue's framing:

```bash
grep -n '"<package>"' <workspace>/package.json    # what is declared now
```

A jump in the leading number sends it to `implementer` whatever the label says.
Breadth is its own kind of hard: a wide patch and minor advisory sweep has cost
more than several isolated majors together, so a wide sweep is not automatically
`mechanic` either.

**Never choose by cost.** The question is what the task needs, not what it would
be nice to pay. A cheaper agent that does the job worse costs more, because the
work comes back.

**One code-writing agent per worktree.** Two agents writing code in the same
worktree corrupt each other's branches. Only `reviewer` agents share a worktree:
their tool grant has no `Edit`, their definition tells them never to change the
checkout, and they build only when the brief says they are alone in it.

## What consumes this

`orchestrate` Step 3, the task hand-off, asks this skill. The other dispatch
sites are fixed by role and name their definition directly:

| Site | Definition |
|---|---|
| `orchestrate` Step 1 | `explorer` |
| `orchestrate` Step 4 fixes and rebases | `implementer` |
| `orchestrate` Step 5 polling | `shepherd` |
| `prep-pr` Steps 4 and 6 | `reviewer` |
| `stress-plan` Step 2 | `attacker` |
| `new-feat` Step 2 | the built-in `Plan` agent |

`new-feat` keeps the built-in `Plan`: it is read-only and runs on the planner's
own model, which is the model whose plan it is.
