# Realtime push: invalidation signals over WebSocket — design

Date: 2026-09-26 · Status: approved in conversation, awaiting written-spec review

## Goal

When a membership fact changes on the server — a cire co-host is removed or has their role changed, a musubi organisation member is removed or re-roled — every open browser tab that shows the affected wedding or organisation learns of it within seconds and re-reads through its normal API. Today an idle, visible tab keeps the rows it loaded until its next request or until it regains focus, which can be hours.

## Decisions (owner)

1. **Invalidation signals only.** A message says "something about topic T changed"; it never carries data. The client refetches through the product's existing API, whose per-request role check remains the authorisation boundary.
2. **Free plan, degrade gracefully.** The design fits the Cloudflare Workers Free plan's Durable Object allowance. If push is unavailable, clients behave exactly as today (refetch on focus / next request). Moving to Workers Paid later needs no code change.
3. **Shared library, one hub per product.** A `@shared/realtime` package holds the hub, publish helper and client. Each product API binds its own hub on its own origin. No central push Worker, no new hostname, no cross-origin tickets.

## Non-goals

- Live data sync (pushing changed rows), user-facing notifications, unread counts, zap messaging transport.
- Cross-product topics.
- Guaranteed delivery. A lost signal is recovered by the next focus or request refetch.

## Architecture

### `@shared/realtime` (new package, `shared/realtime/`)

- **`TopicHub`** — a SQLite-backed Durable Object class. One instance per topic, addressed by `idFromName(topic)`.
  - `fetch` with an upgrade request: accepts the WebSocket through the hibernation API (`state.acceptWebSocket`), tags it with the topic, and enforces a per-topic socket cap (default 50; over the cap, close with a policy code).
  - `setWebSocketAutoResponse` answers the client's ping so a ping never wakes the hub.
  - `publish(signal)` RPC method: sends the serialised signal to every accepted socket; sockets that throw on send are closed.
  - No storage beyond what the hibernation API keeps; no alarms; no server-initiated heartbeats.
- **`publish(namespace, topic, kind)`** — server helper a product calls after a successful write. Resolves the hub stub and calls `publish`. It never throws into the caller: failures are logged and counted, and the write's response is unaffected.
- **`Signal`** — `{ topic: string; kind: SignalKind; at: number }`. `SignalKind` is a closed union, initially `"members-changed"`.
- **Topic names** — `<product>:<entity>:<id>`, validated by one exported pattern (lowercase product and entity, id matching the product's id format). Initial topics: `cire:wedding:<weddingId>`, later `osn:org:<orgId>`.
- **`createTopicSubscription(url, onSignal)`** — framework-free client with a Solid wrapper `useTopic(url, onSignal)`. It opens the socket for the entity on screen, pings on an interval, reconnects with capped exponential backoff and jitter, and **treats every successful reconnect as a signal** so a change missed while disconnected is still refetched. After a bounded number of failed attempts it stops, records one fallback metric, and leaves the existing focus refetch as the only mechanism until the page is reloaded or the entity changes.

### Per product

Each product API adds:

1. **Binding.** A Durable Object binding for `TopicHub` and a `new_sqlite_classes` migration in `wrangler.toml`, mirrored into `[env.dev]` and `[env.production]` (named environments inherit no bindings). Verified with `wrangler deploy --dry-run`.
2. **Subscribe route.** `GET /realtime/:topic`, WebSocket upgrade only:
   - reject unless `Upgrade: websocket`;
   - reject unless the `Origin` header is on the product's allow list (cross-site WebSocket hijacking guard — the socket authenticates with the session cookie);
   - validate the topic against the pattern and that its product prefix is this product;
   - run the product's normal session auth, then its membership check for the entity (cire: the wedding host check; osn: organisation membership);
   - apply the product's existing rate limiter;
   - on success, forward the request to the topic's hub stub; on any failure return a plain HTTP status and never upgrade.
3. **Publish calls** after the write commits, in the write paths that change membership.

### cire (first consumer)

- Publish `members-changed` on `cire:wedding:<weddingId>` after co-host role change and removal (`cire/api/src/routes/organiser-hosts.ts`), and after any other host add/remove path found during planning.
- The organiser portal subscribes to the open wedding's topic. On a signal it refetches the wedding list; a removed or downgraded host's refetch returns the new answer and the existing per-wedding purge drops rows the user may no longer see.
- On reconnect, the subscribe route re-runs the membership check, so a removed host's socket is refused rather than re-admitted.

### osn / musubi (second consumer, later PR)

- Publish `members-changed` on `osn:org:<orgId>` from organisation member removal and role change (`osn/api/src/routes/organisation.ts`); musubi's org views subscribe the same way.

## Failure and degraded behaviour

| Failure | Behaviour |
|---|---|
| Free-plan Durable Object allowance exhausted | Upgrade fails; client falls back after bounded retries; focus refetch as today. |
| Hub error on publish | Write succeeds; failure logged and counted; clients catch up on next focus or reconnect. |
| Network drop | Client reconnects; the reconnect counts as a signal. |
| Deploy restarts the hub | Sockets close; clients reconnect and refetch. |

Nothing about access control depends on a signal arriving.

## Security

- Signals carry no data; only an authorised member can subscribe to a topic, so a listener learns only that "something changed" on an entity they may already see.
- Origin allow list on every upgrade; topic prefix must match the serving product.
- Subscribe is rate-limited with the product's existing limiter; per-topic socket cap bounds a single entity.
- Authorisation is re-checked on every connect, never cached in the hub.

## Observability

Per `wiki/shared/observability/overview.md`: counters for subscribe outcomes (`accepted`, `denied`, `bad_origin`, `rate_limited`), signals published, publish failures, and client fallbacks. Attributes are limited to product, signal kind and outcome — never a topic, entity id or user id. Hub and publish errors are logged through `@shared/observability`.

## Testing

- Hub: broadcast to all sockets, closed-socket cleanup, socket cap, auto-response ping.
- Subscribe route (per product): accepted, not a member, bad origin, bad topic, wrong product prefix, rate-limited.
- Publish helper: swallows and counts hub failure; the calling write still succeeds.
- Client: reconnect-as-signal, backoff bound, fallback after retries, cleanup on unmount.
- cire browser test: a removed co-host's open tab drops the wedding's rows without interaction.

## Docs

- `wiki/shared/free-tier-limits.md`: add the Durable Object and WebSocket limits the design relies on, with measured or cited values.
- New `wiki/shared/realtime.md`: topic naming, how a product adopts the hub, degraded behaviour.
- cire and osn system pages: the new route and publish points.

## Rollout

1. `@shared/realtime` — package, tests, wiki page. No product change.
2. cire — binding, subscribe route, publish on host changes, portal wiring.
3. osn / musubi organisations — when musubi org views are ready.

Each is its own pull request.
