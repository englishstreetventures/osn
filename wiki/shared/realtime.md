---
title: Realtime push
description: "@shared/realtime — invalidation signals over WebSocket: topics, the per-topic hub, how a product adopts it, and what happens when push is unavailable"
tags: [shared, realtime, durable-objects, websocket, system]
related:
  - "[[free-tier-limits]]"
  - "[[backend-patterns]]"
  - "[[frontend-patterns]]"
  - "[[metrics]]"
  - "[[cire-auth]]"
  - "[[cire-host-portal-layout]]"
packages: ["@shared/realtime"]
last-reviewed: 2026-09-27
---

# Realtime push

`@shared/realtime` tells open browser tabs that something on the server changed, so they re-read it through the product's normal API. A signal names a **topic** and a **kind**. It never carries data. The product API's per-request role check stays the only authorisation boundary.

## Topics

`<product>:<entity>:<id>`, matched by `TOPIC_PATTERN` in [protocol.ts](../../shared/realtime/src/protocol.ts): a lowercase product, a lowercase entity of at most 32 letters, and an id of 1–64 characters of `[A-Za-z0-9_-]`. Known products are `REALTIME_PRODUCTS`, and a product joins it when it adopts push. Kinds are `SIGNAL_KINDS`, and today there is one, `members-changed`.

## Pieces

| Piece | Import | Runs on |
|---|---|---|
| Protocol: topics, `Signal`, `PING`/`PONG`, `CLOSE_CODES` | `@shared/realtime` | anywhere |
| `publish()`, `subscribe()`, `HubNamespace` | `@shared/realtime/server` | the product Worker (Effect) |
| `TopicHub` Durable Object | `@shared/realtime/hub` | workerd only — the Worker entry imports it, nothing else |
| `createTopicSubscription()` | `@shared/realtime/client` | the browser (no Effect) |
| `useTopic()` | `@shared/realtime/solid` | Solid components |

One hub instance serves one topic (`getByName(topic)`). It holds sockets through the hibernation API and nothing else. The client's `ping` is answered by the runtime's auto-response, so an idle hub sleeps and is not billed for duration. It caps a topic at 50 open sockets (`TopicHub.socketCap`) and one member at 5 (`TopicHub.subjectCap`). At either cap it first closes sockets that have not pinged for 75 s (close code 4002); this assumes the client's default 25 s `pingIntervalMs` and must grow if that interval does. If the member is still over their cap, it closes that member's own least recently seen other socket with 1008, so a member's own dead sockets — a laptop or phone that changed network — cannot lock out their live tab. If the topic is still over its cap, it refuses the newcomer with 1008. The client treats 1008 as final.

## Adopting it in a product

1. **Bind the hub** in the product's `wrangler.toml`. Add `[[durable_objects.bindings]]` (name of your choice, `class_name = "TopicHub"`) at the top level **and** under every `[env.*]`, because named environments inherit no bindings. Add one top-level `[[migrations]]` with `new_sqlite_classes = ["TopicHub"]`, which named environments do inherit. Check with `wrangler deploy --dry-run --env <tier>` that the binding table lists the Durable Object. A bound class the entry does not export fails the dry run.
2. **Export `TopicHub` from the Worker entry** (`export { TopicHub } from "@shared/realtime/hub"`). Keep that export out of any module Bun tests import, because `cloudflare:workers` exists only on workerd.
3. **Add the subscribe route before the web framework.** Call `subscribe(request, rawTopic, options)` and return its `Response` object as is. An Elysia route cannot do this. Elysia rebuilds a returned `Response` whenever a plugin such as CORS has set headers, and a rebuilt 101 either throws `RangeError` on workerd or loses its socket. Supply the product's session auth, rate limiter and membership check as the options' callbacks, plus an exact `Origin` allow list.
4. **Publish after each write commits, in the background.** Hand `runtime.runPromise(publish(hub, topic, kind, { evictSubjects }))` to the request's `ctx.waitUntil`, so the write's response never waits on the hub (up to `PUBLISH_TIMEOUT_MS`, 2 s). Run it inline only where no execution context exists (tests). Evict the member whose access changed, so their socket reconnects and is checked again — each `evictSubjects` entry must be exactly the string the product's `authenticate` callback returned for that member, since the hub tags sockets with it; any other id evicts nobody. Publish only when the write changed something, because every publish is a billed Durable Object request.
5. **Subscribe in the client** with `useTopic(() => url, onSignal, { onFallback: (outcome) => sendFallbackBeacon(endpoint, outcome) })`, and treat every event as "re-read now". Add the beacon route at `endpoint`: it checks the declared length, limits per IP, and reads the body bounded as it arrives — counting bytes and cancelling the stream once they pass `MAX_FALLBACK_BEACON_BYTES`, as cire's `readBoundedText` ([webhook-body.ts](../../cire/api/src/lib/webhook-body.ts)) does. Never `request.text()` followed by a length check: a body sent with no declared length would be buffered whole first, on a public route. It then hands the text to `readFallbackOutcome` (which refuses anything over `MAX_FALLBACK_BEACON_BYTES` or other than one outcome), counts the outcome with `recordClientFallback`, and answers 204 whatever it was sent. cire's [realtime-fallback.ts](../../cire/api/src/routes/realtime-fallback.ts) is the model.
6. **Allow `wss:` in the portal's CSP.** Chromium 151 blocks a `wss://api.example` socket when `connect-src` lists only `https://api.example`, and opens it once `wss://api.example` is listed. So did the `ws:`/`http:` pair.

   *Measured 2026-09-26 — Playwright's Chromium 151.0.7922.34 against a local page and socket server, one run per policy.*

## When push is unavailable

| Failure | What happens |
|---|---|
| No hub bound (a tier without the binding) | Subscribe answers 503, publish does nothing. Clients fall back. |
| A product's local Bun dev server that never runs the Worker entry | The subscribe path reaches the web framework and answers 404. Clients fall back. |
| Hub error or Free-plan Durable Object quota spent | Subscribe answers 503, and publish logs and counts `error` while the write succeeds. See [[free-tier-limits]]. |
| Network drop or deploy | The runtime closes every hub socket on a deploy. Clients reconnect, and both the loss and the reconnect count as signals. |
| The browser cannot connect at all | After 6 consecutive failed attempts (at most 1 + 2 + 4 + 8 + 16 = 31 s of waiting, plus connect time) the client stops. An attempt counts as failed when its socket closes before the hub has answered anything on it, so a socket that opens and is cut at once does not reset the count. If the socket had been open, it emits one last `stopped` signal first. The product's existing refetch triggers remain. |

Nothing about access control depends on a signal arriving.

A member evicted by a change gets three signals for it: the message, the eviction's `dropped`, and `reconnected`. The others on the topic get one. The message needs a fresh re-read, since a read already in flight may predate the change, and so does the reconnect, since a signal can be lost while the socket is down. The `dropped` carries no time of change, so a product can let it join a re-read already in flight: after an eviction, that is the message's re-read, which already postdates the change. cire does this.

## Adopters

- **cire** — hub bound as `REALTIME_HUB` in [wrangler.toml](../../cire/api/wrangler.toml) (entry `src/entry.ts`); route `GET /realtime/:topic`; publishes `members-changed` on `cire:wedding:<id>` after a co-host add, role change or removal (a removal only when a seat went), in the request's `waitUntil` ([realtime.ts](../../cire/api/src/services/realtime.ts)); a removal, or a role change to one without the dashboard (`helper`), evicts the co-host whose seat changed, while a change between `editor` and `viewer` evicts nobody, since their socket's access still holds; the host portal's `Dashboard` listens on the open wedding. The portal passes `onFallback` and reports the outcome to `POST /api/realtime/fallback`. See [[cire-auth]] and [[cire-host-portal-layout]].

## Observability

Counters in [metrics.ts](../../shared/realtime/src/server/metrics.ts) — see [[metrics]]. On workerd these are recorded into a no-op meter until a workerd metric reader exists:

- `realtime.subscribe.attempts`, by `product` and `outcome`
- `realtime.signal.published`, by `product`, `kind` and `result`
- `realtime.hub.capacity_refused`, by `product`
- `realtime.client.fallbacks`, by `product` and `outcome` (`refused` | `exhausted`)

Spans are `realtime.publish` and `realtime.subscribe`.

The browser client records nothing itself. When a subscription gives up, it calls `onFallback` with the outcome. A product passes that to `sendFallbackBeacon` ([beacon.ts](../../shared/realtime/src/client/beacon.ts)), which POSTs the outcome word to the product's beacon route. The route counts it with `recordClientFallback` ([fallback.ts](../../shared/realtime/src/server/fallback.ts)).

What that count can and cannot show:

- Counters are no-ops on workerd today, so on a deployed Worker the record is the `realtime client fell back` warning in Workers Logs, which keeps 7 days.
- `refused` is the hub's 1008 close.
- `exhausted` merges every refused subscribe (401, 403, 429, 503), a CSP block and a missing hub: the client sees each as a socket that failed to open.
- A dead network stops the beacon too, so the count undercounts.

## Tests

The fast tier, `bun run --cwd shared/realtime test:run`, covers the protocol, `publish`, `subscribe`, the close-code mapping and the client. The hub runs on real workerd in the Miniflare tier, `bun run --cwd shared/realtime test:d1` ([hub.test.ts](../../shared/realtime/tests/d1/hub.test.ts)).
