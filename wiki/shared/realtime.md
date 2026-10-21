---
title: Realtime push
description: "@shared/realtime — invalidation signals over WebSocket: topics, the per-topic hub, how a product adopts it, and what happens when push is unavailable"
tags: [shared, realtime, durable-objects, websocket, system]
related:
  - "[[free-tier-limits]]"
  - "[[backend-patterns]]"
  - "[[frontend-patterns]]"
  - "[[metrics]]"
  - "[[testing-patterns]]"
  - "[[cire-auth]]"
  - "[[cire-host-portal-layout]]"
packages: ["@shared/realtime"]
last-reviewed: 2026-10-20
---

# Realtime push

`@shared/realtime` tells open browser tabs that something on the server changed, so they re-read it through the product's normal API. A signal names a **topic** and a **kind**. It never carries data. The product API's per-request role check stays the only authorisation boundary.

cire is the one product that uses it, so `cire` is the one entry in `REALTIME_PRODUCTS`. See [Adopters](#adopters).

## Topics

`<product>:<entity>:<id>`, matched by `TOPIC_PATTERN` in [protocol.ts](../../shared/realtime/src/protocol.ts): a lowercase product, a lowercase entity of at most 32 letters, and an id of 1–64 characters of `[A-Za-z0-9_-]`. A topic's product must be in `REALTIME_PRODUCTS`. Kinds are `SIGNAL_KINDS`, and today there is one, `members-changed`.

## Pieces

| Piece | Import | Runs on |
|---|---|---|
| Protocol: topics, `Signal`, `PING`/`PONG`, `PING_INTERVAL_MS`, `CLOSE_CODES`, `FALLBACK_OUTCOMES` | `@shared/realtime` | anywhere |
| `publish()`, `subscribe()`, `HubNamespace`; the fallback beacon's `readFallbackOutcome`, `recordClientFallback`, `MAX_FALLBACK_BEACON_BYTES` | `@shared/realtime/server` | the product Worker (Effect) |
| `TopicHub` Durable Object | `@shared/realtime/hub` | workerd only — the Worker entry imports it, nothing else |
| `createTopicSubscription()`, `sendFallbackBeacon()` | `@shared/realtime/client` | the browser (no Effect) |
| `useTopic()` | `@shared/realtime/solid` | Solid components |

## The hub

One hub instance serves one topic (`getByName(topic)`). It holds sockets through the hibernation API and nothing else: no storage, no alarm, no timer. The client's `ping` is answered by the runtime's auto-response, so an idle hub sleeps and is not billed for duration. Any other frame from a client is closed with 1008.

- **Subject.** Each socket is tagged with the subject `subscribe()` admitted. The hub refuses a subject that is not 1–200 characters of `[A-Za-z0-9_-]` with 400, which `subscribe()` answers as 503.
- **Topic cap.** 50 open sockets (`TopicHub.socketCap`).
- **Member cap.** 5 open sockets per subject on a topic (`TopicHub.subjectCap`).
- **Stale sockets.** At either cap the hub first closes sockets that have not pinged for three ping intervals, 75 s (`TopicHub.staleAfterMs`, 3 × `PING_INTERVAL_MS`), with 4002. A tab whose network changed leaves such a socket behind.
- **Over the member cap** after that, the hub closes the member's least recently seen other socket with 1008 and keeps the newcomer. That socket may belong to a live tab; the client treats 1008 as final, so that tab stops receiving push until it remounts.
- **Over the topic cap** after that, the hub closes the newcomer with 1008.
- **Maximum age.** At each publish, a socket accepted more than an hour ago (`TopicHub.maxSocketAgeMs`) is closed with 4001 instead of being sent the signal. It reconnects through `subscribe()`, so a socket that outlived its session or its seat is checked again before it hears anything more.

When a cap closed a socket, the hub's 101 says which in the `x-realtime-capacity` header (`topic` or `subject`), and `subscribe()` counts and logs it in the product Worker. The hub itself has no logger and no metric reader.

| Close code | Sent when | The client |
|---|---|---|
| 1008 | topic full, member's own cap, access revoked, a frame other than `ping` | stops (final) |
| 4001 | `evictSubjects` on a publish, or older than `maxSocketAgeMs` | reconnects |
| 4002 | stale at a cap | reconnects |

## Adopting it in a product

1. **Bind the hub** in the product's `wrangler.toml`. Add `[[durable_objects.bindings]]` (name of your choice, `class_name = "TopicHub"`) at the top level **and** under every `[env.*]`, because named environments inherit no bindings. Add one top-level `[[migrations]]` with `new_sqlite_classes = ["TopicHub"]`, which named environments do inherit. Check with `wrangler deploy --dry-run --env <tier>` that the binding table lists the Durable Object. A bound class the entry does not export fails the dry run.
2. **Export `TopicHub` from the Worker entry** (`export { TopicHub } from "@shared/realtime/hub"`). Keep that export out of any module Bun tests import, because `cloudflare:workers` exists only on workerd.
3. **Add the subscribe route before the web framework**, behind the product's per-IP limiter. Run `runtime.runPromise(subscribe(request, rawTopic, options))` on the product's `ManagedRuntime`, so its logs pass through the redacting logger, and return the `Response` it resolves to as is. An Elysia route cannot do this. Elysia rebuilds a returned `Response` whenever a plugin such as CORS has set headers, and a rebuilt 101 either throws `RangeError` on workerd or loses its socket. Because the route runs before the framework, the framework's middleware does not cover it: put the path behind the product's per-IP limiter (or a Cloudflare rate-limiting rule) before `subscribe()` runs, since `subscribe()`'s own limiters are keyed on the subject and run after `authenticate`.

   The options:

   | Option | What the product supplies |
   |---|---|
   | `product` | its own entry in `REALTIME_PRODUCTS` |
   | `hub` | the binding, or `undefined` on a tier without one |
   | `allowedOrigins` | exact `Origin` values: scheme, host and port, no trailing slash |
   | `acceptsTopic` | its rule for entity and id, applied after the shared pattern |
   | `authenticate` | the caller's subject from its normal session auth, or `null`. The subject must be the member's unique, unchanging, opaque id — the id its membership rows key on — never a handle, email or per-session id |
   | `allow` | its short-window limiter, keyed on the subject |
   | `allowDaily` | a daily ceiling, keyed on the subject. Every admitted subscribe is a Durable Object request against an allowance the whole account shares ([[free-tier-limits]]), so size it from that allowance, not from the short window. An honest member spends it on each mount, each return to a tab hidden for more than two ping intervals, each eviction, each hourly expiry on a topic that publishes, and each deploy; a ceiling too tight for that stops push for a member who switches tabs often |
   | `authorize` | its membership check for the topic's entity |

   `subscribe()` checks in this order, and nothing after a refusal runs:

   | Check | Refused with | Outcome |
   |---|---|---|
   | `GET` with `Upgrade: websocket` | 426 | `not_upgrade` |
   | `Origin` exactly in `allowedOrigins` | 403 | `bad_origin` |
   | topic decodes, parses, is this product's, and `acceptsTopic` | 404 | `bad_topic` |
   | a hub is bound | 503 | `unavailable` |
   | `authenticate` returns a subject | 401 | `unauthenticated` |
   | `allow` | 429, `Retry-After: 60` | `rate_limited` |
   | `allowDaily` | 429 | `daily_limited` |
   | `authorize` | 403 | `denied` |
   | the hub answers 101 | 503 | `unavailable` |

   A callback that throws, or a defect, also answers 503. On success the hub's own 101 comes back, counted as `accepted`, or as `topic_full` when the hub closed the newcomer at the topic cap. A browser sees none of these statuses: a refused upgrade reaches the client as close 1006.
4. **Publish after each write commits, in the background.** Hand `runtime.runPromise(publish(hub, topic, kind, { evictSubjects, revokeSubjects }))` to the request's `ctx.waitUntil`, so the write's response never waits on the hub (up to `PUBLISH_TIMEOUT_MS`, 2 s). Run it inline only where no execution context exists (tests). Name the members whose access changed: `evictSubjects` for a member who may still have access (their socket reconnects and is checked again), `revokeSubjects` for one who lost it (their open sockets are closed with 1008 and the client stops, so they make no refused reconnects). A subject in both lists is revoked. Each entry must be exactly the subject `authenticate` returned for that member, since the hub tags sockets with it; any other string closes nothing. A revoked member's tab that was paused or closed when the publish ran has no socket to close: when it returns it reconnects, is refused, and stops after its failed attempts. Publish only when the write changed something, because every publish is a billed Durable Object request.
5. **Subscribe in the client** with `useTopic(() => url, onSignal, { onFallback: (outcome) => sendFallbackBeacon(endpoint, outcome) })`, and treat every event as "re-read now". Add the beacon route at `endpoint`: it checks the declared length, limits per IP, and reads the body bounded as it arrives — counting bytes and cancelling the stream once they pass `MAX_FALLBACK_BEACON_BYTES`, as cire's `readBoundedText` ([webhook-body.ts](../../cire/api/src/lib/webhook-body.ts)) does. Never `request.text()` followed by a length check: a body sent with no declared length would be buffered whole first, on a public route. It then hands the text to `readFallbackOutcome` (which refuses anything over `MAX_FALLBACK_BEACON_BYTES` or other than one outcome), counts the outcome with `recordClientFallback`, and answers 204 whatever it was sent. cire's [realtime-fallback.ts](../../cire/api/src/routes/realtime-fallback.ts) is the model.
6. **Allow `wss:` in the portal's CSP.** Chromium 151 blocks a `wss://api.example` socket when `connect-src` lists only `https://api.example`, and opens it once `wss://api.example` is listed. So did the `ws:`/`http:` pair.

   *Measured 2026-09-26 — Playwright's Chromium 151.0.7922.34 against a local page and socket server, one run per policy.*

## The client

`createTopicSubscription()` holds one socket and pings every 25 s (`PING_INTERVAL_MS`). A ping unanswered by the next marks the socket dead. It emits:

| Event | When |
|---|---|
| `message` | a well-formed signal arrived |
| `dropped` | an open socket was lost |
| `reconnected` | a socket opened after a loss or a pause |
| `stopped` | it gave up after a socket had been open |

- **Backoff.** Retries wait a random time up to 1 s, doubling per failure up to 30 s. An attempt counts as failed when its socket closes before the hub has answered anything on it, so a socket that opens and is cut at once does not reset the count.
- **Giving up.** After 6 consecutive failed attempts (at most 1 + 2 + 4 + 8 + 16 = 31 s of waiting, plus connect time), or at once on 1008, it stops, emits `stopped` if a socket had been open, and calls `onFallback`. The product's existing refetch triggers remain.
- **After giving up with no socket ever open**, every later subscription to the same origin in that page makes a single attempt for 5 minutes. A socket that answers clears it, and a subscription that has connected before keeps its full budget when it resumes from a pause.
- **Hidden tabs.** Once the tab has been hidden for two ping intervals, it closes its socket with 1000 and stops pinging, which counts as no failure; a hidden tab sends at most two pings before that. When the tab is shown it reconnects with its full attempt budget and emits `reconnected`, so each return costs a new subscribe: one Worker request, one Durable Object request and the product's checks. `pauseWhenHidden: false` turns this off.

## When push is unavailable

| Failure | What happens |
|---|---|
| No hub bound (a tier without the binding) | Subscribe answers 503; publish sends nothing and counts `result="disabled"`. Clients fall back. |
| A product's local Bun dev server that never runs the Worker entry | The subscribe path reaches the web framework and answers 404. Clients fall back. |
| Hub error or Free-plan Durable Object quota spent | Subscribe answers 503, and publish logs and counts `error` while the write succeeds. See [[free-tier-limits]]. |
| Network drop or deploy | The runtime closes every hub socket on a deploy. Clients reconnect, and both the loss and the reconnect count as signals. |
| The browser cannot connect at all | The client gives up as above, and the product's refetch triggers remain. |

Nothing about access control depends on a signal arriving.

For one change, a member who keeps access and is evicted gets three signals: the message, the eviction's `dropped`, and `reconnected`. A revoked member gets the message and `stopped`, or only `stopped` when their socket was past its maximum age. The others on the topic get the message. Each prompts a re-read. The message needs a fresh re-read, since a read already in flight may predate the change, and so does the reconnect, since a signal can be lost while the socket is down. The `dropped` carries no time of change, so a product can let it join a re-read already in flight: after an eviction, that is the message's re-read, which already postdates the change. cire does this.

## Adopters

- **cire** — hub bound as `REALTIME_HUB` in [wrangler.toml](../../cire/api/wrangler.toml) (entry `src/entry.ts`).
  - **Route.** `GET /realtime/:topic` ([routes/realtime.ts](../../cire/api/src/routes/realtime.ts)) checks a per-IP limit of 30 a minute, for requests from the portal's origin only, before it looks anything up; a page on another site cannot spend a visitor's limit, and `subscribe()` refuses that origin anyway. Its `allow` is 30 a minute per organiser and its `allowDaily` is 300 a day per organiser (`REALTIME_SUBSCRIBES_PER_DAY`), counted in D1 (`realtime_subscribe_budget`), so every isolate reads the same count. The per-IP and per-organiser limits count in memory, per isolate. A per-IP refusal answers 429 and logs `realtime subscribe refused` with `outcome: "ip_rate_limited"`, never the address. See [[cire-auth]].
  - **Publish.** `members-changed` on `cire:wedding:<id>` after a seat is added, re-roled, removed or left, and after the wedding is deleted (revoking every seat holder), in the request's `waitUntil` ([services/realtime.ts](../../cire/api/src/services/realtime.ts)). A removal or leave publishes only when a seat went, and a role change only when the role changed. A removal, a leave, and a role change to one without the dashboard (`helper`) **revoke** that member, so their sockets close with 1008 and their tab stops. Any other change closes nobody, since the member's access still holds.
  - **Portal.** `Dashboard` listens on the open wedding and re-reads the wedding list on every event. A signal or a reconnect also makes an open co-host panel (`HostsPanel`) read the seats again, from the same socket. When push stops, the portal reports the outcome to `POST /api/realtime/fallback`. See [[cire-host-portal-layout]].

## Observability

Counters in [metrics.ts](../../shared/realtime/src/server/metrics.ts) — see [[metrics]]. They run in the product Worker, never in the hub, and on workerd they record into a no-op meter until englishstreetventures/osn#501 lands:

- `realtime.subscribe.attempts`, by `product` and `outcome` (the outcomes in the table above)
- `realtime.signal.published`, by `product`, `kind` and `result` (`ok`, `error`, `disabled`)
- `realtime.hub.capacity_refused`, by `product` and `cap` (`topic`: the newcomer was closed; `subject`: the member's own least recently seen socket was)
- `realtime.client.fallbacks`, by `product` and `outcome` (`refused` | `exhausted`)

Spans are `realtime.publish` and `realtime.subscribe`; the subscribe span carries `realtime.outcome`. Logs: `realtime subscribe refused` (warning, for `bad_origin`, `rate_limited` and `daily_limited`), `realtime topic at its socket cap` (warning), `realtime subscribe failed` with the failing step, `realtime hub refused an admitted upgrade`, and `realtime publish failed` (errors). None carries a subject; only the publish failure carries the topic.

The browser client records nothing itself. When a subscription gives up, it calls `onFallback` with the outcome. A product passes that to `sendFallbackBeacon` ([beacon.ts](../../shared/realtime/src/client/beacon.ts)), which POSTs the outcome word to the product's beacon route. The route counts it with `recordClientFallback` ([fallback.ts](../../shared/realtime/src/server/fallback.ts)).

What that count can and cannot show:

- Counters are no-ops on workerd today, so on a deployed Worker the record is the `realtime client fell back` warning in Workers Logs, which keeps 3 days on the Workers Free plan ([[retention]]).
- `refused` is the hub's 1008 close, so it counts every revoked member's tab as well as the caps and protocol errors: a product that revokes on access loss sees one `refused` per revoked tab.
- `exhausted` merges every refused subscribe (401, 403, 429, 503), a CSP block and a missing hub: the client sees each as a socket that failed to open.
- A dead network stops the beacon too, so the count undercounts.

## Tests

No E2E flow can reach the hub: `tools/e2e` runs each API's Bun entry, which never runs the Worker entry, so the stack has no Durable Object. These tiers are the package's coverage ([[testing-patterns]]), and each adopter adds its own route, Worker-entry and browser tests (cire's are listed in [[cire-host-portal-layout]] and `cire/api/tests/routes/realtime.test.ts`):

- **Vitest**, `bun run --cwd shared/realtime test:run`: the topic and signal parsers, `subscribe()`'s refusals and their order, `publish()` against a failing or silent hub, the close-code mapping, the client's reconnect, fallback (with its outcome), hidden-tab and fallback-memory behaviour, `useTopic()`, the fallback beacon, and `readFallbackOutcome`'s bounds.
- **Miniflare**, `bun run --cwd shared/realtime test:d1` ([hub.test.ts](../../shared/realtime/tests/d1/hub.test.ts)): `TopicHub` on real workerd through `subscribe()` and `publish()` — the upgrade, the ping auto-response without a wake, fan-out by topic, eviction and revocation through the helper over a real binding, a publish that meets a socket closed in the same turn, the maximum age, both caps and the stale cull, the close reply, and the hub's own 426 and 400 refusals.
