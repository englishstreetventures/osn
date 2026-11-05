# @shared/realtime

## 0.2.12

### Patch Changes

- Updated dependencies [08d9eaf]
  - @shared/observability@0.20.0

## 0.2.11

### Patch Changes

- Updated dependencies [e6b19ae]
  - @shared/observability@0.19.5

## 0.2.10

### Patch Changes

- Updated dependencies [a56d73d]
  - @shared/observability@0.19.4

## 0.2.9

### Patch Changes

- Updated dependencies [ad20023]
  - @shared/observability@0.19.3

## 0.2.8

### Patch Changes

- Updated dependencies [432200d]
  - @shared/observability@0.19.2

## 0.2.7

### Patch Changes

- a471666: Move `solid-js` from 1.9.15 to 1.9.18. In 1.9.18 a module-level `lazy()`
  keeps its loaded component across an unmount, so a remounted lazy panel
  renders at once instead of a microtask later. The Settings tab test now waits
  for the router to write the fragment, which lands when the navigation's
  transition settles rather than with the panel. `@solidjs/router` stays at
  1.0.0: 1.0.1 is newer than the install's minimum release age.

## 0.2.6

### Patch Changes

- ef3d36d: Dependency bumps within the caution window: `effect`, `@effect/platform-bun`,
  `@effect/platform-node`, `@effect/sql-d1` and `@effect/opentelemetry` 4.0.7
  (with the matching root overrides for `@effect/platform-node-shared`,
  `@effect/sql-d1` and `@effect/sql-sqlite-do`), `jose` 6.2.14, `astro` 7.4.4,
  `@astrojs/solid-js` 7.1.0, `@opentelemetry/*` 0.223.0 and 2.12.0,
  `@growthbook/growthbook` 1.8.0, `@solidjs/start` 2.0.6, `cropperjs` 2.3.1,
  `lucide-solid` 1.59.0, `motion` 13.5.1, `vitest` and the `@vitest/*` packages
  5.0.5 (which clears the moderate dev-server file-read advisory). The root
  overrides for `@opentelemetry/core` (`^2.12.0`) and `seroval` (`~1.6.11`, which
  clears two moderate serialisation advisories) rise with them. `wrangler` stays on 4.149.0, which
  `@cloudflare/vite-plugin` pins exactly. `solid-js` stays on 1.9.15 (see the cire
  changeset for why).
- Updated dependencies [ef3d36d]
  - @shared/observability@0.19.1

## 0.2.5

### Patch Changes

- Updated dependencies [403cd83]
  - @shared/observability@0.19.0

## 0.2.4

### Patch Changes

- 355b956: Type-check with Bun's built-in checker. Each package's `check` script is now `typecheck` and runs `bun check` in place of `tsc --noEmit`, with the test tsconfigs checked the same way. Packages that still need `astro check` keep it. No source changes.
- Updated dependencies [355b956]
  - @shared/observability@0.18.12

## 0.2.3

### Patch Changes

- 18b1291: Dev dependency update: happy-dom 21.0.4, clearing a high advisory in its earlier release.

## 0.2.2

### Patch Changes

- Updated dependencies [a3364fb]
  - @shared/observability@0.18.11

## 0.2.1

### Patch Changes

- 569c73b: Dependency maintenance. The `effect` family moves from 4.0.3 to 4.0.5, a
  patch release. Audit fixes take `fast-uri` to 3.1.8, `http-cache-semantics` to
  4.3.0 and `smol-toml` to 1.9.0, and `valibot` is overridden to ^1.4.2 so the
  `@prisma/dev` tree stops pinning 1.2.0. No runtime API changes are expected
  from these bumps; the repo's typecheck and test suites pass, apart from three
  `cire/host` component tests that also fail on the base branch.
- Updated dependencies [569c73b]
  - @shared/observability@0.18.10

## 0.2.0

### Minor Changes

- 40fd895: `onFallback` now receives why the subscription gave up: `refused` (the hub closed
  the socket with 1008, which includes a revoked member) or `exhausted` (every
  attempt failed); `FALLBACK_OUTCOMES` and `isFallbackOutcome` name them.
  `sendFallbackBeacon` (`@shared/realtime/client`) posts that outcome to a
  product's API. On the server, `readFallbackOutcome` reads a beacon body of at
  most `MAX_FALLBACK_BEACON_BYTES`, and `recordClientFallback` counts the outcome
  as `realtime.client.fallbacks` by product and outcome and logs a warning.
  `subscribe()`'s doc now says the route must sit behind the product's per-IP
  limit.
- 40fd895: `publish()` tries the hub again when a call that revokes members fails: after
  each pause in the new `REVOKE_RETRY_DELAYS_MS` (250 ms, then 750 ms), inside the
  same effect, so inside the caller's `waitUntil`. When every try fails it logs
  `realtime revoke failed` instead of `realtime publish failed`. A publish that
  revokes nobody still tries once. `PublishOptions.revokeRetryDelaysMs` overrides
  the pauses.
- 40fd895: A second signal kind, `tasks-changed`, beside `members-changed`: an entity's
  tasks, or who holds them, changed. A client built before it drops a frame
  carrying it, as it drops any kind it does not know.

## 0.1.2

### Patch Changes

- 5ab88f0: Build with vite 8.3.3 (range `^8.3.3`), which clears the advisory on vite 8.2.0
  through 8.2.3.

## 0.1.1

### Patch Changes

- fa0f54a: Name the GitHub organisation `englishstreetventures` in the `repository` URL and in the comments and tests that cite a repository or issue.

  Comments and tests that pointed at an issue in the private tracker now state the constraint without the reference.

- Updated dependencies [fa0f54a]
  - @shared/observability@0.18.9

## 0.1.0

### Minor Changes

- 2d9205f: Add `@shared/realtime`: invalidation signals over WebSocket. A signal says only
  that a topic (`<product>:<entity>:<id>`) changed; the tab re-reads through the
  product's own API, whose role check stays the only authorisation boundary.

  - `TopicHub` (`@shared/realtime/hub`) — a SQLite-backed Durable Object per topic
    that holds sockets through the hibernation API and answers `ping` with an
    auto-response, so an idle hub sleeps. It caps sockets per topic and per
    member, accepts only an opaque subject id, and closes a socket older than an
    hour at the next publish so it is checked again.
  - `publish()` and `subscribe()` (`@shared/realtime/server`) — publish never
    fails the write that calls it and can evict or revoke members; subscribe
    checks upgrade, origin, topic, session, a short-window and a daily rate limit,
    and membership, cheapest first, and never upgrades a refusal.
  - `createTopicSubscription()` (`@shared/realtime/client`) and `useTopic()`
    (`@shared/realtime/solid`) — a lost or re-opened socket counts as a signal;
    a hidden tab closes its socket and reopens it when shown; after six failed
    attempts the client stops, with one last signal if it had been open, and the
    product's own refetch triggers remain.

  No product uses it yet.
