---
name: evaluate
description: Use when asked to evaluate, compare or weigh a change of tool, platform, vendor, service or architecture — "should we move to X", "evaluate X vs Y", "is X worth it", "I'm hearing good things about X" — or any choice between keeping the current setup and adopting another.
---

# Evaluate

An evaluation compares what the project can **do** in the current state against what it could do in the proposed one, over the life of the project. Cost to switch is one input. It decides the answer only when the functional case is close.

## The question behind the ask

Before gathering anything, write one line: what pain or goal prompted the ask. "Move to Bitbucket" may really mean "keep features after going private". Judge every option against that goal, not against the tool named.

## Options

Always include:
- **Current state**, unchanged.
- **Current state, fixed in place** — the cheapest change that removes the pain without moving (a plan upgrade, a config change, a workaround).
- **Each proposed state.** A proposal that pairs tools ("Bitbucket + Jira") is one option; a tool that only replaces part of the stack ("Dagger") is judged on that part.

## Facts first

Measure the current state from evidence — the repo, APIs, billing, usage — not memory. Check vendor claims (pricing, plan limits, features) against the vendor's own pages, dated today. Mark anything unverified as such.

## Output contract

Produce these sections, in this order:

1. **Goal** — the one line from above.
2. **Verdict** — the recommended option and the single strongest reason. One short paragraph.
3. **Functional comparison** — a table, one row per capability that matters to the goal, one column per option. Cover what applies of: core features, integrations the project relies on (CI, issues, agents and AI tooling, deploy targets), reliability and who runs it, security and compliance, data ownership and lock-in, day-to-day developer and agent experience, where the vendor or project is heading.
4. **Pros and cons per option** — functional only. What it lets you do that the others do not; what it takes away.
5. **Big picture** — where the project will be in 1–3 years (users, repos, tickets, team size, products) and which option fits that state. Say whether switching gets cheaper or dearer with time: a migration at hundreds of tickets is easier than at thousands, and a choice that will need reversing later is worse than one that won't.
6. **Costs** — effort, money, time, for each option: one-off and recurring, both measured where possible.
7. **What would change the answer** — the facts or events that would flip the verdict.

## Weighing

- Rank by functional fit for the future state first. Use cost to break ties or to rule out what the project cannot afford.
- A high switching cost that only grows is a reason to switch **sooner**, if the functional case holds.
- "Fixed in place" wins only if it meets the goal as well as the move does — not just because it is cheaper.
