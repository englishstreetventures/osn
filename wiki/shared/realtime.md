---
title: Realtime push
description: "@shared/realtime — invalidation signals over WebSocket: topics, the per-topic hub, how a product adopts it, and what happens when push is unavailable"
tags: [shared, realtime, durable-objects, websocket, system]
related:
  - "[[free-tier-limits]]"
  - "[[backend-patterns]]"
  - "[[frontend-patterns]]"
  - "[[metrics]]"
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

One hub instance serves one topic (`getByName(topic)`). It holds sockets through the hibernation API and nothing else. The client's `ping` is answered by the runtime's auto-response, so an idle hub sleeps and is not billed for duration. It caps a topic at 50 open sockets (`TopicHub.socketCap`) and one member at 5 (`TopicHub.subjectCap`). At a cap it first closes sockets that have not pinged for 75 s (close code 4002). Only then does it refuse the newcomer with 1008, which the client treats as final.

## Adopting it in a product

1. **Bind the hub** in the product's `wrangler.toml`. Add `[[durable_objects.bindings]]` (name of your choice, `class_name = "TopicHub"`) at the top level **and** under every `[env.*]`, because named environments inherit no bindings. Add one top-level `[[migrations]]` with `new_sqlite_classes = ["TopicHub"]`, which named environments do inherit. Check with `wrangler deploy --dry-run --env <tier>` that the binding table lists the Durable Object. A bound class the entry does not export fails the dry run.
2. **Export `TopicHub` from the Worker entry** (`export { TopicHub } from "@shared/realtime/hub"`). Keep that export out of any module Bun tests import, because `cloudflare:workers` exists only on workerd.
3. **Add the subscribe route before the web framework.** Call `subscribe(request, rawTopic, options)` and return its `Response` object as is. An Elysia route cannot do this. Elysia rebuilds a returned `Response` whenever a plugin such as CORS has set headers, and a rebuilt 101 either throws `RangeError` on workerd or loses its socket. Supply the product's session auth, rate limiter and membership check as the options' callbacks, plus an exact `Origin` allow list.
4. **Publish after each write commits, in the background.** Hand `runtime.runPromise(publish(hub, topic, kind, { evictSubjects }))` to the request's `ctx.waitUntil`, so the write's response never waits on the hub (up to `PUBLISH_TIMEOUT_MS`, 2 s). Run it inline only where no execution context exists (tests). Evict the member whose access changed, so their socket reconnects and is checked again. Publish only when the write changed something, because every publish is a billed Durable Object request.
5. **Subscribe in the client** with `useTopic(() => url, onSignal)`, and treat every event as "re-read now".
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

A member whose seat changed gets three signals for one change: the message, the eviction's `dropped`, and `reconnected`. Each prompts a re-read. The others on the topic get one.

## Observability

Counters in [metrics.ts](../../shared/realtime/src/server/metrics.ts) — see [[metrics]]. On workerd these are recorded into a no-op meter until a workerd metric reader exists:

- `realtime.subscribe.attempts`, by `product` and `outcome`
- `realtime.signal.published`, by `product`, `kind` and `result`
- `realtime.hub.capacity_refused`, by `product`

Spans are `realtime.publish` and `realtime.subscribe`. The browser client records no metric. It exposes `onFallback`, which is where a product hooks one once a browser telemetry channel exists.

## Tests

The fast tier, `bun run --cwd shared/realtime test:run`, covers the protocol, `publish`, `subscribe`, the close-code mapping and the client. The hub runs on real workerd in the Miniflare tier, `bun run --cwd shared/realtime test:d1` ([hub.test.ts](../../shared/realtime/tests/d1/hub.test.ts)).
