---
title: "osn-api's shared state on a Durable Object, not Upstash Redis"
tags:
  - decision
  - osn
  - infrastructure
  - durable-objects
related:
  - "[[coordination-store]]"
  - "[[rate-limiting]]"
  - "[[sessions]]"
  - "[[free-tier-limits]]"
  - "[[decisions/README]]"
last-reviewed: 2026-10-27
---

# osn-api's shared state on a Durable Object, not Upstash Redis

osn-api keeps its short-lived shared state — the limiters no native binding
carries, the per-account caps, ceremony entries, guess counters, step-up
token ids and lockout counters — in `CoordinationStore`, a SQLite-backed Durable Object class
with **one object per key**, bound as `COORDINATION`. It replaced Upstash Redis
over REST. Two pieces of state left the shared store altogether: the record of
rotated-out session tokens moved to D1, and the per-user one-minute limiters to
Cloudflare's native Rate Limiting bindings. [[coordination-store]] is the
reference page; this one records the choices and why.

## The store

| Option | Why not, or why |
|---|---|
| **Upstash Redis over REST** (what ran) | A second vendor and a second subprocessor holding auth state, a secret pair in every tier, an HTTP hop from the Worker to Sydney on every call, and a paid plan for dev's second database |
| **In-memory, per isolate** | Isolates share nothing, so a limit or a single-use guard holds only inside one. An idle isolate is evicted after 70–140 s, which resets an hour-window limiter or a 15-minute lockout, and every deploy resets everything |
| **One Durable Object per namespace, or a fixed set of shards** | Every key in a namespace would queue behind every other on one object. Kept as the fallback if per-key objects prove too slow to create on the auth path |
| **One Durable Object per key** (chosen) | Same account, same contract and same processor as the rest of the platform, and no secret to hold. Each call on one key is atomic, which gives exact single-use claims and counters. A hot key loads only its own object |

Every consumer fails closed, the recovery-code lockout included: a counter that
cannot be read in front of a code is no throttle at all.

## The owner's decisions

Answered on 2026-10-26.

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Where do rotated-session records live? | **D1**, table `rotated_sessions` | Every token refresh writes one, and each must last the session's 30 days. On the Durable Object that is two requests per refresh and an object per token that lives a month; refreshes would spend the Free allowance first (below). In D1 the record commits in the same batch as the session that replaces it, so a session never exists without its predecessor's record, and a failed write is a `DatabaseError` the token route already answers as "status unknown" |
| 2 | Where do the per-user one-minute limiters run? | **Native Rate Limiting bindings**, `RL_USER_20_60` and `RL_USER_60_60` | People search fires once per debounced keystroke. A binding costs no request and needs no store, where the Durable Object would cost a request per keystroke |
| 3 | englishstreetventures/osn#1735 (a smoke probe that reaches the store) | **Folded in**: `GET /health/coordination`, asked by the smoke check | `/health` touches no store, so a Worker that cannot reach the store passed every probe. A write, read and remove under a key the server makes needs no OAuth client and takes no input |
| 4 | Which files may still say Redis? | Historical ones only: `docs/superpowers/`, `.claude/metrics/`, changelogs, an unreleased changeset, and this folder | Rewriting a changelog or a session record falsifies it |
| 5 | Which plan does each account run? | **Production on Workers Paid; dev stays on Workers Free** | The store sits on every auth path and fails closed. On Free, a spent daily allowance — shared with cire's realtime hub, and spendable by anyone from the public hosts — would stop sign-in until 00:00 UTC. Paid has no daily cap and bills the overage. On dev that outage costs only dev sign-in. The deploy token has no billing scope, so the owner switches the plan in the dashboard before the first release |
| 6 | Do the account export and erasure limiters move too? | **Yes** | They ran in memory on the Worker, so "one export a day per account" held only per isolate |

*Estimated, not measured: with 5-minute access tokens a person signed in for 8 hours refreshes about 96 times a day. On the Durable Object that would be about 192 requests, so about 520 such people would spend dev's 100,000 a day on refreshes alone.*

## Per-colo counting for per-user keys

Cloudflare counts a native rate limit per colo, not globally. For the per-IP
auth limiters that was already accepted: one caller's requests reach one colo.
A per-user key is different, because one user's devices can reach several colos
— a phone on mobile data and a laptop on home broadband — and each colo keeps
its own count. So a user's graph, organisation and recommendation limits can be
looser than their budget by up to the number of colos in use. That is accepted:
these limits bound request volume, and none guards a secret.

Profile create, delete and set-default are keyed **per IP**
(`osn/api/src/routes/profile.ts`), not per user, so they share the per-IP
`RL_AUTH_IP_*` tiers under their own key prefix and need no per-user binding.

## What the cutover drops

Nothing moved from Upstash. On the first release the new store starts empty:

- a ceremony begun before the release fails once, and the user starts it again;
- every rate-limit window and lockout counter starts again;
- a token rotated before the release has no rotation record, so a replay of it
  fails as an unknown token instead of revoking its family.

Each lasts as long as what it lost would have: minutes for a ceremony, a day at
most for a window, 15 minutes for a lockout, and up to 30 days for a token
rotated out before the release. Accepted.

## Worth revisiting when

- The Durable Object request bill on production is no longer small next to the
  Workers Paid base fee.
- First-call latency on the auth path, read from the `CoordinationStore`
  namespace's dashboard, hurts sign-in: shard by namespace (above).
- Cloudflare changes what Workers Free allows, or what counts as a request.
