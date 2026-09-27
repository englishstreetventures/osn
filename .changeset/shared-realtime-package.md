---
"@shared/realtime": minor
---

Add `@shared/realtime`: invalidation signals over WebSocket. A signal says only
that a topic (`<product>:<entity>:<id>`) changed; the tab re-reads through the
product's own API, whose role check stays the only authorisation boundary.

- `TopicHub` (`@shared/realtime/hub`) — a SQLite-backed Durable Object per topic
  that holds sockets through the hibernation API and answers `ping` with an
  auto-response, so an idle hub sleeps.
- `publish()` and `subscribe()` (`@shared/realtime/server`) — publish never
  fails the write that calls it; subscribe checks upgrade, origin, topic,
  session, rate limit and membership, cheapest first, and never upgrades a
  refusal.
- `createTopicSubscription()` (`@shared/realtime/client`) and `useTopic()`
  (`@shared/realtime/solid`) — a lost or re-opened socket counts as a signal;
  after six failed attempts the client stops, with one last signal if it had
  been open, and the product's own refetch triggers remain.

No product uses it yet.
