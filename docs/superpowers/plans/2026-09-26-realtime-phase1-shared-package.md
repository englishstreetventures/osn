# Realtime push, phase 1 — `@shared/realtime` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new workspace package, `@shared/realtime`. It holds the per-topic Durable Object hub, the server `publish` and `subscribe` helpers, and the browser client with its Solid wrapper, all tested, with a wiki page and Durable Object limits cited in `wiki/shared/free-tier-limits.md`. No product uses it yet.

**Architecture:** `TopicHub` is a SQLite-backed Durable Object (DO), one instance per topic. It holds the topic's WebSockets through the hibernation API and answers the client's `ping` with an auto-response, so an idle hub sleeps and costs nothing. A product API admits an upgrade with `subscribe()` and hands the hub's 101 response straight back. After a write commits, the product calls `publish()`, which calls the hub's `publish` RPC method. A signal says only "topic T changed"; the browser client re-reads through the product's normal API.

**Tech Stack:** TypeScript, Cloudflare Workers Durable Objects (`cloudflare:workers`), Effect v4 (`4.0.0-rc.112`, server half only), `@shared/observability` metrics, SolidJS (wrapper only), Vitest 4 under Bun, Miniflare 4 (`bun:test`) for the hub on real workerd.

**Spec:** `docs/superpowers/specs/2026-09-26-realtime-push-design.md`. Read it before any task. This plan covers rollout step 1 only. Step 2 (cire) is `docs/superpowers/plans/2026-09-26-realtime-phase2-cire.md`, and step 3 (osn/musubi) is not planned yet.

## Global Constraints

Every task's requirements include this section.

- **Tests live in `tests/` at the package root, mirroring `src/`**, and no test helpers go in `src/`. The Miniflare tier lives in `tests/d1/`. It imports `bun:test`, runs only under `bun run test:d1`, and is excluded from Vitest by path (AGENTS.md "Tests"; precedent `osn/api/vitest.config.ts` and `osn/api/tests/d1/waituntil.test.ts`).
- **Both test runners run under Bun.** Vitest runs as `bunx --bun vitest` and the hub tier as `bun test`. Bun's `Response` accepts status 101 and Node's throws `RangeError`. Never run these suites under Node.
- **Effect stays in the backend.** Only `src/server/**` imports `effect`. `src/protocol.ts`, `src/index.ts` and `src/client/**` import neither `effect` nor `@shared/observability` (AGENTS.md: "Frontends do not use Effect"). `publish()` and `subscribe()` return Effects whose requirement type is `never`. The product runs them on the `ManagedRuntime` it already built at boot (cire: `runCire` in `cire/api/src/observability.ts`). This package never calls `Effect.provide` and never builds a runtime.
- **Only `src/server/hub.ts` imports `cloudflare:workers`.** That module exists only on workerd, so nothing Vitest or `bun test` loads may import `hub.ts`, except the Miniflare fixture, which bundles it with `external: ["cloudflare:workers"]`. `src/server/index.ts` does not re-export the hub; products import it from `@shared/realtime/hub`.
- **Observability** (`wiki/shared/observability/overview.md`): no `console.*`, and no raw OpenTelemetry constructors. Metrics come only from `createCounter` in `@shared/observability/metrics`, declared once in `src/server/metrics.ts` under the `realtime` namespace. Attribute values are closed string-literal unions: `product`, `kind`, `outcome`/`result`. **Never a topic, entity id or subject id** in a metric attribute. Server errors go through `Effect.logError`. Spans are `realtime.publish` and `realtime.subscribe`.
- **Validation:** plain type guards in `src/protocol.ts`. There is no TypeBox or Effect Schema in this package, so the TypeBox-at-the-boundary / Schema-in-services split is not in play here.
- **Changeset:** one file naming `"@shared/realtime": minor`. It is a versioned package (`"version": "0.0.0"`, the `@shared/sortable` precedent in commit `46204b23`). Never put an `@cire/*` package in the same changeset.
- **Installs:** never a bare `bun install`. Splice `bun.lock` by hand (Task 1 gives the exact lines) and prove it with `bun install --frozen-lockfile`. The frozen install alone does not catch a mismatched range: in a trial, `^4.1.10` against a locked `^4.1.11` still printed "no changes". So also check that `git diff bun.lock` shows only the spliced lines.
- **Free plan:** the hub uses the SQLite backend, the only one on Workers Free (https://developers.cloudflare.com/durable-objects/platform/pricing/ — "Workers Free plan: Only Durable Objects with SQLite storage backend are available."). The hub holds no `setTimeout`/`setInterval`, no alarm and no storage writes, because any timer keeps an object awake and billed (https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).
- **Public repository:** no tracker ID, finding tag or phase code in any comment, commit message, changeset, wiki page or PR body (`wiki/conventions/code-comments.md`, lint rule `house/no-tracker-ref-in-comment`). Comments say what the code guarantees now.
- **Lint:** add no oxlint warnings, because CI holds a warning ceiling. Put at most one doc block before a declaration (`house/no-stacked-doc-block`). The vendored `anti-slop` rules are **errors**. For example, `no-unknown-returns` fails an exported signature returning `unknown`, and `no-unsafe-dictionary-type` fails a `Record<string, unknown>` cast. Run `bunx --bun oxlint -c oxlintrc.json shared/realtime` after each task. It must print nothing.
- **Formatting:** the code blocks below are not oxfmt-formatted. Lefthook formats staged files in write mode on commit (AGENTS.md: "Lefthook formats and lints staged files on commit"), and `bun run fmt:check` must be clean before the PR.
- **Wiki:** invoke the `write-wiki` skill before editing anything under `wiki/`, and `obsidian:obsidian-markdown` for syntax.

## Review Focus

These are the input classes and failure modes the spec implies but does not spell out, most likely first. Each has a test in the task that owns it.

1. **A socket that dies without a close frame.** Deploys, network changes and mobile sleep cause this, and the hub sees code 1006. The hub must answer with a legal code (1000), because `close(1006)` throws. The dead socket must not hold a place under the cap. The client must treat the loss as a signal and reconnect. Tests:
   - Task 5: `replyCloseCode(1006) === 1000` in Vitest, and stale-socket culling at the cap in Miniflare. Miniflare cannot drop a socket without a close frame, so the reply itself is proved on the deploy walk.
   - Task 6: drop → `dropped` → reconnect → `reconnected`.
2. **A topic string off the network that is not quite a topic.** For example `CIRE:wedding:x`, `cire:wedding:`, an id of 65 characters, `cire:wedding:a:b`, a malformed percent escape, or another product's prefix. Each must be refused with 404, before any auth or hub work. Tests: Task 1 (`parseTopic` table) and Task 4 (subscribe refusals).
3. **A hub that is missing, throwing, slow or over its Free quota.** Subscribe must answer 503 and count `unavailable`, and it must never throw into the Worker. Publish must return normally so the write's response is unaffected. Tests: Task 3 (reject, hang past the timeout, no hub) and Task 4 (hub fetch throws, hub answers non-101, a product callback throws, a defect).
4. **A browser where push can never work.** Examples: the local Bun dev server with no hub, a Content-Security-Policy (CSP) that blocks `wss:`, or a proxy that strips upgrades. The client must make exactly `maxAttempts` attempts, call `onFallback` once, and leave no timer running. A constructor that throws counts as a failed attempt. Test: Task 6.
5. **A socket that goes silent but never closes** (half-open TCP). A ping still unanswered at the next ping must drop the socket and reconnect with a `dropped` signal. Background-tab timer throttling must not cause false drops, so liveness keys on the unanswered ping, not on wall-clock silence. Test: Task 6.

## Deliberate additions to the spec

Each serves the spec's stated intent. Stress-plan and review may reject them. If they do, delete the named task steps.

- **Subject tags and eviction.** `subscribe()` tags each socket with the caller's subject, and `publish()` takes `evictSubjects`. After sending the signal, the hub closes those subjects' sockets with close code 4001, so they reconnect and the product re-runs the membership check. Without this, a removed member who keeps their tab open keeps hearing that the entity changed, which contradicts the spec's Security section ("only an authorised member can subscribe"). Cost: one tag and one loop. Lives in Tasks 3–5.
- **`dropped` and `stopped` signals as well as `reconnected`.** The spec treats every successful reconnect as a signal. `dropped` fires when an open socket is lost, so a change can be caught while the socket is down. `stopped` fires once when a subscription that had been open gives up. That covers a member removed during an outage: every reconnect after the removal is refused, so no reconnect ever succeeds. Lives in Task 6.
- **Close code 1008 is final for the client.** The hub sends it when a frame is illegal, or when a cap is still exceeded after stale sockets were closed. Neither clears by retrying, so the client stops at once instead of spending its attempts. Lives in Task 6.
- **A per-member cap, and stale-socket culling at a cap.** One member may hold at most 5 sockets on a topic. At either cap the hub first closes sockets that have not pinged for 75 s (close code 4002). Without these, one member, or sockets whose clients vanished without a close frame, could fill a topic and switch push off for everyone on it. Lives in Task 5.
- **`"osn"` is not a product yet.** The spec names `osn:org:<orgId>` as a later topic, but osn's browser auth cannot reach a socket (Open question 3). `REALTIME_PRODUCTS` is `["cire"]` until step 3 is designed. Lives in Task 1.

## File Structure

```
shared/realtime/
  package.json                    exports ".", "./server", "./hub", "./client", "./solid"
  tsconfig.json                   server + protocol: ES2023 + @cloudflare/workers-types
  tsconfig.client.json            browser + protocol: solid.json (DOM) — client code and client tests
  vitest.config.ts                Solid plugin, node env, excludes tests/d1
  src/
    index.ts                      re-exports protocol.ts (runtime-neutral)
    protocol.ts                   products, kinds, Signal, TOPIC_PATTERN, parse/format, isSignal, PING/PONG, CLOSE_CODES
    server/
      index.ts                    publish, subscribe, HubNamespace, metrics names — NOT the hub
      metrics.ts                  REALTIME_METRICS + typed counters + metric* wrappers
      headers.ts                  HUB_TOPIC_HEADER, HUB_SUBJECT_HEADER
      hub-namespace.ts            HubNamespace / HubStub structural types
      publish.ts                  publish(hub, topic, kind, options) → Effect<void>
      subscribe.ts                subscribe(request, rawTopic, options) → Effect<Response>
      close-reply.ts              replyCloseCode — the close code a hub answers with
      hub.ts                      TopicHub (imports cloudflare:workers)
    client/
      index.ts                    re-exports subscription.ts
      subscription.ts             createTopicSubscription(url, onSignal, options)
      solid.ts                    useTopic(url, onSignal, options)
  tests/
    tsconfig.json                 server + d1 tests: workers types + bun types
    protocol.test.ts
    support/fake-hub.ts           HubNamespace stand-in for server tests
    support/fake-websocket.ts     WebSocket stand-in for client tests
    server/metrics.test.ts
    server/close-reply.test.ts
    server/publish.test.ts
    server/subscribe.test.ts
    d1/fixtures/hub-worker.ts     Worker that hosts TopicHub for Miniflare
    d1/hub.test.ts                hub on real workerd
    client/subscription.test.ts
    client/solid.test.ts
```

Three tsconfigs, because one program cannot hold both the DOM lib and `@cloudflare/workers-types`. The two declare the same globals (`Request`, `WebSocket`, …). `cire/api` already splits its checks the same way (`cire/api/package.json` `check` script, `cire/api/tests/tsconfig.json`).

**Evidence this plan's code runs.** On 2026-09-26, every code block in this plan was extracted verbatim into a throwaway worktree of this branch and run there. The worktree was then removed. With the four fixes now folded into the plan (below):

| Gate | Result |
|---|---|
| `bun install --frozen-lockfile` | +26 `bun.lock` lines |
| `check` | all three programs exit 0 |
| `test:run` | 7 files, 89 tests pass: protocol 23, metrics 2, close-reply 8, publish 7, subscribe 23, subscription 19, solid 7 |
| `test:d1` | 14 pass, on Miniflare 4.20260730.0 at compatibility date 2025-03-01 |
| `oxlint shared/realtime` | nothing reported |
| `check:jest-dom-markers` | pass |
| Task 5 Step 5 (auto-response removed) | the ping test fails, as it should |

The four fixes that run found:

- the fixture exported a string constant, which workerd refuses at startup;
- `anti-slop(no-unknown-returns)` on `HubStub.publish`;
- `anti-slop(no-unsafe-dictionary-type)` in `isSignal`;
- the fake hub's handler type, which followed from the second fix.

The formatter would still rewrite 7 files; lefthook does that on commit.

After the stress-plan round, the revised code was re-run the same way, and the table shows those counts. The hub, client and protocol changes each come with a test that was seen to fail without them.

---

### Task 1: Package scaffold and the wire protocol

**Files:**
- Create: `shared/realtime/package.json`
- Create: `shared/realtime/tsconfig.json`
- Create: `shared/realtime/tsconfig.client.json`
- Create: `shared/realtime/tests/tsconfig.json`
- Create: `shared/realtime/vitest.config.ts`
- Create: `shared/realtime/src/protocol.ts`
- Create: `shared/realtime/src/index.ts`
- Modify: `bun.lock` (two splices, below)
- Test: `shared/realtime/tests/protocol.test.ts`

**Interfaces:**
- Produces (every later task and phase 2 rely on these exact names):
  - `REALTIME_PRODUCTS = ["cire"] as const`, `type RealtimeProduct` (osn joins when step 3 is designed — see Open questions)
  - `SIGNAL_KINDS = ["members-changed"] as const`, `type SignalKind`
  - `interface Signal { readonly topic: string; readonly kind: SignalKind; readonly at: number }`
  - `TOPIC_PATTERN: RegExp`, `interface ParsedTopic { product: RealtimeProduct; entity: string; id: string }`
  - `parseTopic(topic: string): ParsedTopic | null`
  - `formatTopic(product: RealtimeProduct, entity: string, id: string): string | null`
  - `isSignal(value: unknown): value is Signal`
  - `PING = "ping"`, `PONG = "pong"`, `CLOSE_CODES = { policy: 1008, evicted: 4001, stale: 4002 } as const`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@shared/realtime",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./server": "./src/server/index.ts",
    "./hub": "./src/server/hub.ts",
    "./client": "./src/client/index.ts",
    "./solid": "./src/client/solid.ts"
  },
  "scripts": {
    "check": "tsc --noEmit && tsc --noEmit -p tsconfig.client.json && tsc --noEmit -p tests/tsconfig.json",
    "test": "bunx --bun vitest",
    "test:run": "bunx --bun vitest run",
    "test:d1": "bun test tests/d1/"
  },
  "dependencies": {
    "@shared/observability": "workspace:*",
    "effect": "4.0.0-rc.112"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^5.20260903.1",
    "@shared/typescript-config": "workspace:*",
    "happy-dom": "^20.12.2",
    "miniflare": "^4.20260730.0",
    "solid-js": "^1.9.15",
    "vite": "^8.2.2",
    "vite-plugin-solid": "^2.11.14",
    "vitest": "^4.1.11"
  },
  "peerDependencies": {
    "solid-js": "^1.9.15"
  },
  "peerDependenciesMeta": {
    "solid-js": {
      "optional": true
    }
  }
}
```

Every range already appears in `bun.lock` for another workspace: `effect` and `@cloudflare/workers-types` in `cire/api`, `miniflare` in `cire/api`, and the Solid/Vitest set in `shared/rp-auth`. So no new package resolves. `test:d1` is the repo's name for the Miniflare tier, which root `bun run test:d1` runs serially through turbo (`turbo.json` task `test:d1`, CI step "D1 integration tests" in `.github/workflows/ci.yml`).

- [ ] **Step 2: Write the three tsconfigs**

`shared/realtime/tsconfig.json`:

```json
{
  // Server half and the protocol it shares: Workers types only, so a DOM or
  // Bun global in server code fails `check`.
  "extends": "@shared/typescript-config/base.json",
  "compilerOptions": {
    "lib": ["ES2023"],
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/index.ts", "src/protocol.ts", "src/server/**/*"]
}
```

`shared/realtime/tsconfig.client.json`:

```json
{
  // Browser half: DOM + Solid. Never includes src/server — the DOM lib and
  // the Workers types declare the same globals and cannot share a program.
  "extends": "@shared/typescript-config/solid.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"]
  },
  "include": [
    "src/index.ts",
    "src/protocol.ts",
    "src/client/**/*",
    "tests/protocol.test.ts",
    "tests/client/**/*",
    "tests/support/fake-websocket.ts"
  ]
}
```

`shared/realtime/tests/tsconfig.json`:

```json
{
  // Server tests and the Miniflare tier. Bun types are allowed here (bun:test,
  // Bun.build) and nowhere in ../tsconfig.json.
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types", "bun-types"]
  },
  "include": ["./server/**/*", "./d1/**/*", "./support/fake-hub.ts", "../src/index.ts", "../src/protocol.ts", "../src/server/**/*"]
}
```

`bun-types` comes from the root `package.json` devDependencies, which is how `cire/api/tests/tsconfig.json` resolves it too.

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import solid from "vite-plugin-solid";
import { configDefaults, defineConfig } from "vitest/config";

// `tests/d1/` is the Miniflare tier: it imports `bun:test` and boots workerd,
// so it runs under `bun run test:d1` and is excluded here by path.
// `configDefaults.exclude` is spread because naming `exclude` replaces the
// default list. The Solid plugin is what makes `solid-js` resolve to its
// browser build, where effects run; the node build's effects never do.
export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/d1/**"],
    setupFiles: ["../../shared/test-config/no-jest-dom.ts"],
  },
});
```

The `setupFiles` entry is required: `scripts/check-jest-dom-markers.sh` fails any `vitest.config.ts` that imports `vite-plugin-solid` without naming a jest-dom path.

- [ ] **Step 4: Write the failing test `tests/protocol.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import {
  CLOSE_CODES,
  formatTopic,
  isSignal,
  parseTopic,
  PING,
  PONG,
  REALTIME_PRODUCTS,
  SIGNAL_KINDS,
} from "../src/protocol";

describe("parseTopic", () => {
  it("splits a well-formed topic of a known product", () => {
    expect(parseTopic("cire:wedding:wed_0a1b")).toEqual({
      product: "cire",
      entity: "wedding",
      id: "wed_0a1b",
    });
  });

  it.each([
    ["an unknown product", "pulse:event:evt_1"],
    ["a product that has not adopted realtime", "osn:org:org_1"],
    ["an uppercase product", "CIRE:wedding:wed_1"],
    ["an uppercase entity", "cire:Wedding:wed_1"],
    ["a 33-character entity", `cire:${"e".repeat(33)}:wed_1`],
    ["an empty id", "cire:wedding:"],
    ["a fourth segment", "cire:wedding:wed_1:x"],
    ["a 65-character id", `cire:wedding:${"a".repeat(65)}`],
    ["a percent-encoded colon", "cire%3Awedding%3Awed_1"],
    ["a space in the id", "cire:wedding:wed 1"],
    ["an empty string", ""],
  ])("refuses %s", (_label, topic) => {
    expect(parseTopic(topic)).toBeNull();
  });

  it("accepts an id of exactly 64 characters and an entity of exactly 32", () => {
    expect(parseTopic(`cire:wedding:${"a".repeat(64)}`)?.id).toHaveLength(64);
    expect(parseTopic(`cire:${"e".repeat(32)}:wed_1`)?.entity).toHaveLength(32);
  });
});

describe("formatTopic", () => {
  it("builds a topic that parses back to its parts", () => {
    expect(formatTopic("cire", "wedding", "wed_1")).toBe("cire:wedding:wed_1");
  });

  it("returns null when the parts cannot form a topic", () => {
    expect(formatTopic("cire", "wedding", "")).toBeNull();
    expect(formatTopic("cire", "wedding", "has:colon")).toBeNull();
  });
});

describe("isSignal", () => {
  const good = { topic: "cire:wedding:wed_1", kind: "members-changed", at: 1_700_000_000_000 };

  it("accepts a well-formed signal", () => {
    expect(isSignal(good)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "members-changed"],
    ["an unknown kind", { ...good, kind: "rows-changed" }],
    ["a malformed topic", { ...good, topic: "nope" }],
    ["a missing at", { topic: good.topic, kind: good.kind }],
    ["a non-finite at", { ...good, at: Number.NaN }],
  ])("refuses %s", (_label, value) => {
    expect(isSignal(value)).toBe(false);
  });
});

describe("wire constants", () => {
  it("pins the frames and close codes both ends agree on", () => {
    expect([PING, PONG]).toEqual(["ping", "pong"]);
    expect(CLOSE_CODES).toEqual({ policy: 1008, evicted: 4001, stale: 4002 });
    expect(REALTIME_PRODUCTS).toEqual(["cire"]);
    expect(SIGNAL_KINDS).toEqual(["members-changed"]);
  });
});
```

- [ ] **Step 5: Splice `bun.lock`, install, run the test and watch it fail**

In `bun.lock`, insert this block immediately before the line `    "shared/redis": {`:

```
    "shared/realtime": {
      "name": "@shared/realtime",
      "version": "0.0.0",
      "dependencies": {
        "@shared/observability": "workspace:*",
        "effect": "4.0.0-rc.112",
      },
      "devDependencies": {
        "@cloudflare/workers-types": "^5.20260903.1",
        "@shared/typescript-config": "workspace:*",
        "happy-dom": "^20.12.2",
        "miniflare": "^4.20260730.0",
        "solid-js": "^1.9.15",
        "vite": "^8.2.2",
        "vite-plugin-solid": "^2.11.14",
        "vitest": "^4.1.11",
      },
      "peerDependencies": {
        "solid-js": "^1.9.15",
      },
      "optionalPeers": [
        "solid-js",
      ],
    },
```

Insert these two lines immediately before `    "@shared/redis": ["@shared/redis@workspace:shared/redis"],`:

```
    "@shared/realtime": ["@shared/realtime@workspace:shared/realtime"],

```

Run from the repo root: `bun install --frozen-lockfile`, then `git diff --stat bun.lock`.
Expected: the install succeeds, and the diff is exactly 26 added lines. This splice was verified on 2026-09-26 in a throwaway worktree of this branch.

Run: `bun run --cwd shared/realtime test:run`
Expected: FAIL, with `tests/protocol.test.ts` unable to resolve `../src/protocol`.

- [ ] **Step 6: Write `src/protocol.ts` and `src/index.ts`**

`shared/realtime/src/protocol.ts`:

```ts
/**
 * The wire contract shared by a product API, its hub and the browser: which
 * topics exist, what a signal says, and the frames and close codes both ends
 * agree on. It imports nothing, so server, hub and client can all depend on it.
 */

/**
 * Products that own topics. A topic's first segment must be one of these. A
 * product joins the list when it adopts realtime push.
 */
export const REALTIME_PRODUCTS = ["cire"] as const;
export type RealtimeProduct = (typeof REALTIME_PRODUCTS)[number];

/** What a signal can say. Closed: a new kind is a new member here. */
export const SIGNAL_KINDS = ["members-changed"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** "Something about `topic` changed" — never the data itself. */
export interface Signal {
  readonly topic: string;
  readonly kind: SignalKind;
  /** Server time the signal was published, in ms since the epoch. */
  readonly at: number;
}

/**
 * `<product>:<entity>:<id>`. Product and entity are lowercase letters, the
 * entity at most 32; the id is 1–64 characters of `[A-Za-z0-9_-]`, wide enough
 * for every id the products mint. A product narrows the id further before it
 * trusts it.
 */
export const TOPIC_PATTERN = /^([a-z]+):([a-z]{1,32}):([A-Za-z0-9_-]{1,64})$/;

export interface ParsedTopic {
  readonly product: RealtimeProduct;
  readonly entity: string;
  readonly id: string;
}

const isProduct = (value: string): value is RealtimeProduct =>
  (REALTIME_PRODUCTS as readonly string[]).includes(value);

const isKind = (value: unknown): value is SignalKind =>
  typeof value === "string" && (SIGNAL_KINDS as readonly string[]).includes(value);

/** The topic's parts, or null when it is not a topic of a known product. */
export function parseTopic(topic: string): ParsedTopic | null {
  const match = TOPIC_PATTERN.exec(topic);
  if (!match) return null;
  const [, product, entity, id] = match;
  if (product === undefined || entity === undefined || id === undefined) return null;
  if (!isProduct(product)) return null;
  return { product, entity, id };
}

/** A topic built from its parts, or null when they would not parse back. */
export function formatTopic(product: RealtimeProduct, entity: string, id: string): string | null {
  const topic = `${product}:${entity}:${id}`;
  return parseTopic(topic) ? topic : null;
}

/** True when a decoded frame is a well-formed signal. */
export function isSignal(value: unknown): value is Signal {
  if (typeof value !== "object" || value === null) return false;
  if (!("topic" in value) || !("kind" in value) || !("at" in value)) return false;
  const { topic, kind, at } = value;
  return (
    typeof topic === "string" &&
    parseTopic(topic) !== null &&
    isKind(kind) &&
    typeof at === "number" &&
    Number.isFinite(at)
  );
}

/** The text frame a client sends to keep its socket alive, and the hub's reply. */
export const PING = "ping";
export const PONG = "pong";

/**
 * Close codes the hub sends. The client treats `policy` as final and every
 * other close as a loss to recover from.
 */
export const CLOSE_CODES = {
  /** The topic is full, or the client sent a frame the protocol does not allow. */
  policy: 1008,
  /** The subject's membership changed: reconnect so it is checked again. */
  evicted: 4001,
  /** The hub needed room and this socket had not pinged lately: reconnect if still wanted. */
  stale: 4002,
} as const;
```

`shared/realtime/src/index.ts`:

```ts
export {
  CLOSE_CODES,
  formatTopic,
  isSignal,
  parseTopic,
  PING,
  PONG,
  REALTIME_PRODUCTS,
  SIGNAL_KINDS,
  TOPIC_PATTERN,
  type ParsedTopic,
  type RealtimeProduct,
  type Signal,
  type SignalKind,
} from "./protocol";
```

- [ ] **Step 7: Run the test and the type-check and watch them pass**

Run: `bun run --cwd shared/realtime test:run`
Expected: PASS, with every case in `tests/protocol.test.ts` green.

Run: `bun run --cwd shared/realtime check`
Expected: exit 0. All three programs compile. `tests/tsconfig.json` already has input, because it includes `../src/index.ts` and `../src/protocol.ts`, so `tsc` does not stop on TS18003 (no inputs).

- [ ] **Step 8: Commit**

```bash
git add shared/realtime/package.json shared/realtime/tsconfig.json shared/realtime/tsconfig.client.json \
  shared/realtime/tests/tsconfig.json shared/realtime/vitest.config.ts shared/realtime/src/protocol.ts \
  shared/realtime/src/index.ts shared/realtime/tests/protocol.test.ts bun.lock
git commit -m "Add @shared/realtime with the topic and signal protocol"
```

---

### Task 2: Realtime metrics

**Files:**
- Create: `shared/realtime/src/server/metrics.ts`
- Test: `shared/realtime/tests/server/metrics.test.ts`

**Interfaces:**
- Consumes: `RealtimeProduct`, `SignalKind` (Task 1)
- Produces:
  - `REALTIME_METRICS = { subscribeAttempts: "realtime.subscribe.attempts", signalPublished: "realtime.signal.published", hubCapacityRefused: "realtime.hub.capacity_refused" } as const`
  - `type SubscribeOutcome = "accepted" | "not_upgrade" | "bad_origin" | "bad_topic" | "unauthenticated" | "rate_limited" | "denied" | "unavailable"`
  - `type PublishResult = "ok" | "error" | "disabled"`
  - `metricSubscribe(product: RealtimeProduct, outcome: SubscribeOutcome): void`
  - `metricSignalPublished(product: RealtimeProduct, kind: SignalKind, result: PublishResult): void`
  - `metricHubCapacityRefused(product: RealtimeProduct): void`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { REALTIME_METRICS } from "../../src/server/metrics";

describe("REALTIME_METRICS naming", () => {
  it("every name follows realtime.{domain}.{subject}[.{measurement}], lowercase and dotted", () => {
    const nameRe = /^realtime\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
    for (const name of Object.values(REALTIME_METRICS)) {
      expect(name, `${name} does not match ${nameRe}`).toMatch(nameRe);
    }
  });

  it("every metric name is unique", () => {
    const values = Object.values(REALTIME_METRICS);
    expect(new Set(values).size).toBe(values.length);
  });
});
```

Run: `bun run --cwd shared/realtime test:run tests/server/metrics.test.ts`
Expected: FAIL, because `../../src/server/metrics` does not resolve.

- [ ] **Step 2: Write `src/server/metrics.ts`**

```ts
/**
 * Realtime metrics — every counter this package emits is declared here once.
 *
 * Attribute values are closed unions: the serving product, the signal kind and
 * an outcome. A topic, entity id or subject id never reaches an attribute;
 * those belong in logs and spans.
 */
import { createCounter } from "@shared/observability/metrics";

import type { RealtimeProduct, SignalKind } from "../protocol";

export const REALTIME_METRICS = {
  subscribeAttempts: "realtime.subscribe.attempts",
  signalPublished: "realtime.signal.published",
  hubCapacityRefused: "realtime.hub.capacity_refused",
} as const;

/**
 * How one subscribe request ended. Every outcome but `accepted` answers with a
 * plain HTTP status and never upgrades.
 */
export type SubscribeOutcome =
  | "accepted"
  | "not_upgrade"
  | "bad_origin"
  | "bad_topic"
  | "unauthenticated"
  | "rate_limited"
  | "denied"
  | "unavailable";

/** `disabled`: the product has no hub bound, so nothing was sent. */
export type PublishResult = "ok" | "error" | "disabled";

const subscribeAttempts = createCounter<{ product: RealtimeProduct; outcome: SubscribeOutcome }>({
  name: REALTIME_METRICS.subscribeAttempts,
  description: "WebSocket subscribe requests, by serving product and outcome",
  unit: "{request}",
});

const signalPublished = createCounter<{
  product: RealtimeProduct;
  kind: SignalKind;
  result: PublishResult;
}>({
  name: REALTIME_METRICS.signalPublished,
  description: "Signals handed to a hub after a write, by product, kind and result",
  unit: "{signal}",
});

const hubCapacityRefused = createCounter<{ product: RealtimeProduct }>({
  name: REALTIME_METRICS.hubCapacityRefused,
  description: "Sockets a hub closed because its topic was at the socket cap",
  unit: "{socket}",
});

export const metricSubscribe = (product: RealtimeProduct, outcome: SubscribeOutcome): void =>
  subscribeAttempts.inc({ product, outcome });

export const metricSignalPublished = (
  product: RealtimeProduct,
  kind: SignalKind,
  result: PublishResult,
): void => signalPublished.inc({ product, kind, result });

export const metricHubCapacityRefused = (product: RealtimeProduct): void =>
  hubCapacityRefused.inc({ product });
```

- [ ] **Step 3: Run the test and watch it pass**

Run: `bun run --cwd shared/realtime test:run tests/server/metrics.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
git add shared/realtime/src/server/metrics.ts shared/realtime/tests/server/metrics.test.ts
git commit -m "Declare the realtime counters"
```

---

### Task 3: `publish()` — the server's side of a change

**Files:**
- Create: `shared/realtime/src/server/hub-namespace.ts`
- Create: `shared/realtime/src/server/publish.ts`
- Create: `shared/realtime/tests/support/fake-hub.ts`
- Test: `shared/realtime/tests/server/publish.test.ts`

**Interfaces:**
- Consumes: `parseTopic`, `Signal`, `SignalKind` (Task 1); `metricSignalPublished` (Task 2)
- Produces:
  - `interface HubStub { fetch(request: Request): Promise<Response>; publish(signal: Signal, evictSubjects: readonly string[]): Promise<number> }`
  - `interface HubNamespace { getByName(name: string): HubStub }`. A product's `DurableObjectNamespace<TopicHub>` is assignable to it, which Task 5's fixture and phase 2's `Env` prove by type-check.
  - `interface PublishOptions { readonly evictSubjects?: readonly string[]; readonly timeoutMs?: number }`
  - `PUBLISH_TIMEOUT_MS = 2_000`
  - `publish(hub: HubNamespace | undefined, topic: string, kind: SignalKind, options?: PublishOptions): Effect.Effect<void>` — never fails

- [ ] **Step 1: Write `tests/support/fake-hub.ts`**

```ts
import type { Signal } from "../../src/protocol";
import type { HubNamespace } from "../../src/server/hub-namespace";

export interface PublishCall {
  readonly name: string;
  readonly signal: Signal;
  readonly evictSubjects: readonly string[];
}

export interface FetchCall {
  readonly name: string;
  readonly request: Request;
}

/**
 * A hub binding the server tests drive by hand. Each call is recorded; the
 * two handlers decide what the "hub" answers.
 */
export function fakeHub(handlers: {
  publish?: (call: PublishCall) => Promise<number>;
  fetch?: (call: FetchCall) => Promise<Response>;
}): { hub: HubNamespace; publishes: PublishCall[]; fetches: FetchCall[] } {
  const publishes: PublishCall[] = [];
  const fetches: FetchCall[] = [];
  const hub: HubNamespace = {
    getByName: (name) => ({
      publish: (signal, evictSubjects) => {
        const call = { name, signal, evictSubjects };
        publishes.push(call);
        return handlers.publish ? handlers.publish(call) : Promise.resolve(0);
      },
      fetch: (request) => {
        const call = { name, request };
        fetches.push(call);
        return handlers.fetch
          ? handlers.fetch(call)
          : Promise.resolve(new Response(null, { status: 101 }));
      },
    }),
  };
  return { hub, publishes, fetches };
}
```

- [ ] **Step 2: Write the failing test `tests/server/publish.test.ts`**

```ts
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeHub } from "../support/fake-hub";

const { metricSignalPublished } = vi.hoisted(() => ({ metricSignalPublished: vi.fn() }));
vi.mock("../../src/server/metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/metrics")>()),
  metricSignalPublished,
}));

import { publish } from "../../src/server/publish";

const TOPIC = "cire:wedding:wed_1";

beforeEach(() => metricSignalPublished.mockReset());

describe("publish", () => {
  it("hands the hub for the topic a signal and the subjects to evict", async () => {
    const { hub, publishes } = fakeHub({});
    const before = Date.now();

    await Effect.runPromise(publish(hub, TOPIC, "members-changed", { evictSubjects: ["usr_bob"] }));

    expect(publishes).toHaveLength(1);
    const [call] = publishes;
    expect(call?.name).toBe(TOPIC);
    expect(call?.signal.topic).toBe(TOPIC);
    expect(call?.signal.kind).toBe("members-changed");
    expect(call?.signal.at).toBeGreaterThanOrEqual(before);
    expect(call?.evictSubjects).toEqual(["usr_bob"]);
    expect(metricSignalPublished).toHaveBeenCalledWith("cire", "members-changed", "ok");
  });

  it("evicts nobody unless asked", async () => {
    const { hub, publishes } = fakeHub({});
    await Effect.runPromise(publish(hub, TOPIC, "members-changed"));
    expect(publishes[0]?.evictSubjects).toEqual([]);
  });

  it("does nothing, and says so, when the product has no hub bound", async () => {
    await Effect.runPromise(publish(undefined, TOPIC, "members-changed"));
    expect(metricSignalPublished).toHaveBeenCalledWith("cire", "members-changed", "disabled");
  });

  it("succeeds when the hub rejects, and counts the error", async () => {
    const { hub } = fakeHub({ publish: () => Promise.reject(new Error("hub down")) });
    await expect(Effect.runPromise(publish(hub, TOPIC, "members-changed"))).resolves.toBeUndefined();
    expect(metricSignalPublished).toHaveBeenCalledWith("cire", "members-changed", "error");
  });

  it("succeeds when getByName itself throws", async () => {
    const hub = {
      getByName: () => {
        throw new Error("binding broken");
      },
    };
    await expect(Effect.runPromise(publish(hub, TOPIC, "members-changed"))).resolves.toBeUndefined();
    expect(metricSignalPublished).toHaveBeenCalledWith("cire", "members-changed", "error");
  });

  it("gives up on a hub that never answers, within the timeout", async () => {
    const { hub } = fakeHub({ publish: () => new Promise(() => {}) });
    const started = Date.now();
    await Effect.runPromise(publish(hub, TOPIC, "members-changed", { timeoutMs: 30 }));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(metricSignalPublished).toHaveBeenCalledWith("cire", "members-changed", "error");
  });

  it("refuses a malformed topic without touching the hub", async () => {
    const { hub, publishes } = fakeHub({});
    await Effect.runPromise(publish(hub, "not a topic", "members-changed"));
    expect(publishes).toHaveLength(0);
    expect(metricSignalPublished).not.toHaveBeenCalled();
  });
});
```

Run: `bun run --cwd shared/realtime test:run tests/server/publish.test.ts`
Expected: FAIL, because `../../src/server/publish` does not resolve.

- [ ] **Step 3: Write `src/server/hub-namespace.ts`**

```ts
import type { Signal } from "../protocol";

/**
 * The slice of a hub's Durable Object stub the helpers use. A product's
 * `DurableObjectNamespace<TopicHub>` satisfies `HubNamespace`, so production
 * passes its binding and tests pass a stand-in.
 */
export interface HubStub {
  fetch(request: Request): Promise<Response>;
  /** Resolves to how many sockets the signal reached. */
  publish(signal: Signal, evictSubjects: readonly string[]): Promise<number>;
}

export interface HubNamespace {
  getByName(name: string): HubStub;
}
```

`Promise<number>`, not `Promise<unknown>`: the repo's `anti-slop(no-unknown-returns)` lint rule fails an exported signature that returns `unknown`. It fails with an error, not a warning.

- [ ] **Step 4: Write `src/server/publish.ts`**

```ts
import { Cause, Data, Effect } from "effect";

import { parseTopic, type Signal, type SignalKind } from "../protocol";
import type { HubNamespace } from "./hub-namespace";
import { metricSignalPublished } from "./metrics";

class HubPublishError extends Data.TaggedError("HubPublishError")<{ readonly reason: string }> {}

export interface PublishOptions {
  /**
   * Subjects whose sockets the hub closes after sending the signal, so each
   * reconnects and has its membership checked again.
   */
  readonly evictSubjects?: readonly string[];
  /** Overrides {@link PUBLISH_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** Longest a write waits on the hub before it gives up on the signal. */
export const PUBLISH_TIMEOUT_MS = 2_000;

/**
 * Tell every open tab on `topic` that `kind` changed. Run it after the write
 * has committed. It never fails: with no hub bound it does nothing, and a hub
 * that errors or is slow is logged and counted while the caller carries on —
 * a lost signal is recovered by the client's next refetch.
 */
export const publish = (
  hub: HubNamespace | undefined,
  topic: string,
  kind: SignalKind,
  options: PublishOptions = {},
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const parsed = parseTopic(topic);
    if (!parsed) return Effect.logError("realtime publish refused a malformed topic", { kind });
    if (!hub) return Effect.sync(() => metricSignalPublished(parsed.product, kind, "disabled"));
    const signal: Signal = { topic, kind, at: Date.now() };
    return Effect.tryPromise({
      try: () => hub.getByName(topic).publish(signal, options.evictSubjects ?? []),
      catch: (cause) => new HubPublishError({ reason: String(cause) }),
    }).pipe(
      Effect.timeout(options.timeoutMs ?? PUBLISH_TIMEOUT_MS),
      Effect.andThen(Effect.sync(() => metricSignalPublished(parsed.product, kind, "ok"))),
      Effect.catchCause((cause) =>
        Effect.logError("realtime publish failed", {
          topic,
          kind,
          reason: Cause.pretty(cause),
        }).pipe(Effect.andThen(Effect.sync(() => metricSignalPublished(parsed.product, kind, "error")))),
      ),
      Effect.withSpan("realtime.publish", {
        attributes: { "realtime.product": parsed.product, "realtime.kind": kind },
      }),
    );
  });
```

These combinators were checked against `effect@4.0.0-rc.112` on 2026-09-26 by running a script: `Effect.timeout(ms)` fails a slow promise with `TimeoutError`, `Effect.catchCause` recovers failures and defects, and `Effect.tryPromise` catches a synchronous throw inside `try`. The v3 names that no longer compile are listed in `wiki/shared/effect-v4-api.md`.

- [ ] **Step 5: Run the test and watch it pass**

Run: `bun run --cwd shared/realtime test:run tests/server/publish.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Type-check**

Run: `bun run --cwd shared/realtime check`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add shared/realtime/src/server/hub-namespace.ts shared/realtime/src/server/publish.ts \
  shared/realtime/tests/support/fake-hub.ts shared/realtime/tests/server/publish.test.ts
git commit -m "Add publish(), which never fails the write that calls it"
```

---

### Task 4: `subscribe()` — admitting an upgrade

**Files:**
- Create: `shared/realtime/src/server/headers.ts`
- Create: `shared/realtime/src/server/subscribe.ts`
- Create: `shared/realtime/src/server/index.ts`
- Test: `shared/realtime/tests/server/subscribe.test.ts`

**Interfaces:**
- Consumes: `parseTopic`, `ParsedTopic`, `RealtimeProduct` (Task 1); `metricSubscribe`, `SubscribeOutcome` (Task 2); `HubNamespace` (Task 3)
- Produces:
  - `HUB_TOPIC_HEADER = "x-realtime-topic"`, `HUB_SUBJECT_HEADER = "x-realtime-subject"` (read by Task 5's hub)
  - `interface SubscribeOptions { product; hub; allowedOrigins; acceptsTopic; authenticate; allow; authorize }`, with exact types in the code below
  - `subscribe(request: Request, rawTopic: string, options: SubscribeOptions): Effect.Effect<Response>` — never fails. It returns the hub's 101 `Response` object unchanged on success, and on refusal a bodiless `Response` with 426/403/404/401/429 (plus `retry-after: 60`)/403/503.
  - `@shared/realtime/server` exports: `publish`, `PUBLISH_TIMEOUT_MS`, `PublishOptions`, `subscribe`, `SubscribeOptions`, `HubNamespace`, `HubStub`, `REALTIME_METRICS`, `SubscribeOutcome`, `PublishResult`

The order of checks is part of the contract. The cheapest go first, and nothing after a refusal runs: method and upgrade header, then `Origin`, then topic, then hub presence, then session, then rate limit, then membership. The rate limit comes after the session, because it is keyed on the subject. It comes before membership, because the membership check is the costliest step and must not be free for a signed-in caller to hammer.

- [ ] **Step 1: Write the failing test `tests/server/subscribe.test.ts`**

```ts
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ParsedTopic } from "../../src/protocol";
import { fakeHub } from "../support/fake-hub";

const { metricSubscribe } = vi.hoisted(() => ({ metricSubscribe: vi.fn() }));
vi.mock("../../src/server/metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/metrics")>()),
  metricSubscribe,
}));

import { HUB_SUBJECT_HEADER, HUB_TOPIC_HEADER } from "../../src/server/headers";
import type { HubNamespace } from "../../src/server/hub-namespace";
import { subscribe, type SubscribeOptions } from "../../src/server/subscribe";

const ORIGIN = "https://host.example.test";
const TOPIC = "cire:wedding:wed_1";
const RAW = encodeURIComponent(TOPIC);

function upgradeRequest(headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(`https://api.example.test/realtime/${RAW}`, {
    method,
    headers: { upgrade: "websocket", origin: ORIGIN, cookie: "session=secret", ...headers },
  });
}

function options(overrides: Partial<SubscribeOptions> = {}, hub?: HubNamespace): SubscribeOptions {
  return {
    product: "cire",
    hub: hub ?? fakeHub({}).hub,
    allowedOrigins: [ORIGIN],
    acceptsTopic: (topic: ParsedTopic) => topic.entity === "wedding",
    authenticate: async () => "usr_alice",
    allow: async () => true,
    authorize: async () => true,
    ...overrides,
  };
}

const run = (request: Request, raw: string, opts: SubscribeOptions) =>
  Effect.runPromise(subscribe(request, raw, opts));

beforeEach(() => metricSubscribe.mockReset());

describe("subscribe — admitted", () => {
  it("returns the hub's own 101 response, untouched", async () => {
    const hubResponse = new Response(null, { status: 101 });
    const { hub, fetches } = fakeHub({ fetch: async () => hubResponse });

    const res = await run(upgradeRequest(), RAW, options({}, hub));

    expect(res).toBe(hubResponse);
    expect(fetches[0]?.name).toBe(TOPIC);
    expect(metricSubscribe).toHaveBeenCalledWith("cire", "accepted");
  });

  it("hands the hub a fresh request: upgrade, topic and subject only, never the browser's headers", async () => {
    const { hub, fetches } = fakeHub({});
    await run(upgradeRequest({ [HUB_SUBJECT_HEADER]: "usr_forged" }), RAW, options({}, hub));

    const forwarded = fetches[0]?.request;
    expect(forwarded?.headers.get("upgrade")).toBe("websocket");
    expect(forwarded?.headers.get(HUB_TOPIC_HEADER)).toBe(TOPIC);
    expect(forwarded?.headers.get(HUB_SUBJECT_HEADER)).toBe("usr_alice");
    expect(forwarded?.headers.get("cookie")).toBeNull();
    expect(forwarded?.headers.get("origin")).toBeNull();
  });
});

describe("subscribe — refused before anything costly", () => {
  it.each([
    ["a request with no upgrade header", upgradeRequest({ upgrade: "" }), RAW, 426, "not_upgrade"],
    ["a POST", upgradeRequest({}, "POST"), RAW, 426, "not_upgrade"],
    ["a missing Origin", new Request(`https://api.example.test/realtime/${RAW}`, { headers: { upgrade: "websocket" } }), RAW, 403, "bad_origin"],
    ["a foreign Origin", upgradeRequest({ origin: "https://evil.example" }), RAW, 403, "bad_origin"],
    ["an Origin with a trailing slash", upgradeRequest({ origin: `${ORIGIN}/` }), RAW, 403, "bad_origin"],
    ["a malformed topic", upgradeRequest(), encodeURIComponent("cire:wedding:"), 404, "bad_topic"],
    ["a broken percent escape", upgradeRequest(), "cire%3Awedding%3A%E0%A4%A", 404, "bad_topic"],
    ["another product's topic", upgradeRequest(), encodeURIComponent("osn:org:org_1"), 404, "bad_topic"],
    ["an entity this product refuses", upgradeRequest(), encodeURIComponent("cire:vendor:v_1"), 404, "bad_topic"],
  ])("refuses %s", async (_label, request, raw, status, outcome) => {
    const authenticate = vi.fn(async () => "usr_alice");
    const { hub, fetches } = fakeHub({});
    const res = await run(request, raw, options({ authenticate }, hub));
    expect(res.status).toBe(status);
    expect(authenticate).not.toHaveBeenCalled();
    expect(fetches).toHaveLength(0);
    expect(metricSubscribe).toHaveBeenCalledWith("cire", outcome);
  });

  it("answers 503 without authenticating when no hub is bound", async () => {
    const authenticate = vi.fn(async () => "usr_alice");
    const res = await run(upgradeRequest(), RAW, { ...options({ authenticate }), hub: undefined });
    expect(res.status).toBe(503);
    expect(authenticate).not.toHaveBeenCalled();
    expect(metricSubscribe).toHaveBeenCalledWith("cire", "unavailable");
  });
});

describe("subscribe — refused by the product", () => {
  it("401s a caller with no session", async () => {
    const res = await run(upgradeRequest(), RAW, options({ authenticate: async () => null }));
    expect(res.status).toBe(401);
    expect(metricSubscribe).toHaveBeenCalledWith("cire", "unauthenticated");
  });

  it("429s a rate-limited caller before checking membership", async () => {
    const authorize = vi.fn(async () => true);
    const res = await run(upgradeRequest(), RAW, options({ allow: async () => false, authorize }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(authorize).not.toHaveBeenCalled();
    expect(metricSubscribe).toHaveBeenCalledWith("cire", "rate_limited");
  });

  it("keys the rate limit on the subject", async () => {
    const allow = vi.fn(async () => true);
    await run(upgradeRequest(), RAW, options({ allow }));
    expect(allow).toHaveBeenCalledWith("usr_alice");
  });

  it("403s a caller who is not a member, and never reaches the hub", async () => {
    const { hub, fetches } = fakeHub({});
    const res = await run(upgradeRequest(), RAW, options({ authorize: async () => false }, hub));
    expect(res.status).toBe(403);
    expect(fetches).toHaveLength(0);
    expect(metricSubscribe).toHaveBeenCalledWith("cire", "denied");
  });

  it("passes the parsed topic to the membership check", async () => {
    const authorize = vi.fn(async () => true);
    await run(upgradeRequest(), RAW, options({ authorize }));
    expect(authorize).toHaveBeenCalledWith("usr_alice", {
      product: "cire",
      entity: "wedding",
      id: "wed_1",
    });
  });
});

describe("subscribe — failures answer 503 and never throw", () => {
  it.each([
    ["authenticate throws", { authenticate: async () => Promise.reject(new Error("d1 down")) }],
    ["the limiter throws", { allow: async () => Promise.reject(new Error("binding gone")) }],
    ["the membership check throws", { authorize: async () => Promise.reject(new Error("d1 down")) }],
    [
      "acceptsTopic throws (a defect)",
      {
        acceptsTopic: () => {
          throw new Error("bug");
        },
      },
    ],
  ])("when %s", async (_label, overrides) => {
    const res = await run(upgradeRequest(), RAW, options(overrides as Partial<SubscribeOptions>));
    expect(res.status).toBe(503);
    expect(metricSubscribe).toHaveBeenCalledWith("cire", "unavailable");
  });

  it("when the hub's fetch rejects", async () => {
    const { hub } = fakeHub({ fetch: () => Promise.reject(new Error("over quota")) });
    const res = await run(upgradeRequest(), RAW, options({}, hub));
    expect(res.status).toBe(503);
  });

  it("when the hub answers anything but 101", async () => {
    const { hub } = fakeHub({ fetch: async () => new Response(null, { status: 400 }) });
    const res = await run(upgradeRequest(), RAW, options({}, hub));
    expect(res.status).toBe(503);
    expect(metricSubscribe).toHaveBeenCalledWith("cire", "unavailable");
  });
});
```

Run: `bun run --cwd shared/realtime test:run tests/server/subscribe.test.ts`
Expected: FAIL, because `../../src/server/headers` does not resolve.

- [ ] **Step 2: Write `src/server/headers.ts`**

```ts
/**
 * Headers `subscribe()` sets on the request it hands the hub. The hub trusts
 * them because only a product Worker can reach it through its binding, and
 * `subscribe()` builds that request fresh instead of forwarding the browser's
 * headers — so a browser cannot set either one.
 */
export const HUB_TOPIC_HEADER = "x-realtime-topic";
export const HUB_SUBJECT_HEADER = "x-realtime-subject";
```

- [ ] **Step 3: Write `src/server/subscribe.ts`**

```ts
import { Data, Effect } from "effect";

import { parseTopic, type ParsedTopic, type RealtimeProduct } from "../protocol";
import { HUB_SUBJECT_HEADER, HUB_TOPIC_HEADER } from "./headers";
import type { HubNamespace } from "./hub-namespace";
import { metricSubscribe, type SubscribeOutcome } from "./metrics";

class SubscribeStepFailed extends Data.TaggedError("SubscribeStepFailed")<{
  readonly step: "authenticate" | "rate_limit" | "authorize" | "hub";
  readonly reason: string;
}> {}

type Refusal = Exclude<SubscribeOutcome, "accepted">;

const REFUSAL_STATUS = {
  not_upgrade: 426,
  bad_origin: 403,
  bad_topic: 404,
  unauthenticated: 401,
  rate_limited: 429,
  denied: 403,
  unavailable: 503,
} as const satisfies Record<Refusal, number>;

export interface SubscribeOptions {
  /** The product serving this route. A topic of any other product is refused. */
  readonly product: RealtimeProduct;
  /** The product's hub binding. Absent ⇒ every request answers 503 and clients fall back. */
  readonly hub: HubNamespace | undefined;
  /**
   * Exact `Origin` values allowed to open a socket — scheme, host and port,
   * no trailing slash. The socket rides the session cookie, so this is the
   * guard against another site opening one in the member's name.
   */
  readonly allowedOrigins: readonly string[];
  /** The product's rule for entity and id, applied after the shared pattern. */
  readonly acceptsTopic: (topic: ParsedTopic) => boolean;
  /** The caller's subject from the product's normal session auth, or null. */
  readonly authenticate: (request: Request) => Promise<string | null>;
  /** The product's rate limiter, keyed on the subject: true to proceed. */
  readonly allow: (subject: string) => Promise<boolean>;
  /** The product's membership check: may `subject` read `topic`'s entity? */
  readonly authorize: (subject: string, topic: ParsedTopic) => Promise<boolean>;
}

const decodeTopic = (raw: string): string | null => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
};

/**
 * Admit one WebSocket upgrade for `rawTopic` (the path segment, still
 * percent-encoded), or refuse it with a plain HTTP status. Checks run cheapest
 * first and nothing after a refusal runs. On success the hub's 101 response is
 * returned untouched: the product must hand that exact object back to the
 * runtime, never through a framework that rebuilds responses — a rebuilt 101
 * loses its socket.
 */
export const subscribe = (
  request: Request,
  rawTopic: string,
  options: SubscribeOptions,
): Effect.Effect<Response> => {
  const refuse = (outcome: Refusal): Effect.Effect<Response> =>
    Effect.sync(() => {
      metricSubscribe(options.product, outcome);
      return new Response(null, {
        status: REFUSAL_STATUS[outcome],
        headers: outcome === "rate_limited" ? { "retry-after": "60" } : {},
      });
    });

  const step = <A>(name: SubscribeStepFailed["step"], run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new SubscribeStepFailed({ step: name, reason: String(cause) }),
    });

  return Effect.gen(function* () {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return yield* refuse("not_upgrade");
    }
    const origin = request.headers.get("origin");
    if (origin === null || !options.allowedOrigins.includes(origin)) return yield* refuse("bad_origin");

    const topic = decodeTopic(rawTopic);
    const parsed = topic === null ? null : parseTopic(topic);
    if (
      topic === null ||
      parsed === null ||
      parsed.product !== options.product ||
      !options.acceptsTopic(parsed)
    ) {
      return yield* refuse("bad_topic");
    }

    const hub = options.hub;
    if (!hub) return yield* refuse("unavailable");

    const subject = yield* step("authenticate", () => options.authenticate(request));
    if (!subject) return yield* refuse("unauthenticated");
    const allowed = yield* step("rate_limit", () => options.allow(subject));
    if (!allowed) return yield* refuse("rate_limited");
    const member = yield* step("authorize", () => options.authorize(subject, parsed));
    if (!member) return yield* refuse("denied");

    const upgrade = new Request(request.url, {
      headers: { upgrade: "websocket", [HUB_TOPIC_HEADER]: topic, [HUB_SUBJECT_HEADER]: subject },
    });
    const response = yield* step("hub", () => hub.getByName(topic).fetch(upgrade));
    if (response.status !== 101) {
      yield* Effect.logError("realtime hub refused an admitted upgrade", { status: response.status });
      return yield* refuse("unavailable");
    }
    yield* Effect.sync(() => metricSubscribe(options.product, "accepted"));
    return response;
  }).pipe(
    Effect.catchTag("SubscribeStepFailed", (failure) =>
      Effect.logError("realtime subscribe failed", {
        step: failure.step,
        reason: failure.reason,
      }).pipe(Effect.andThen(refuse("unavailable"))),
    ),
    Effect.catchDefect((defect) =>
      Effect.logError("realtime subscribe failed on a defect", { reason: String(defect) }).pipe(
        Effect.andThen(refuse("unavailable")),
      ),
    ),
    Effect.withSpan("realtime.subscribe", { attributes: { "realtime.product": options.product } }),
  );
};
```

The subject is never logged: it is a person's id. The redacting logger scrubs by key (`wiki/shared/observability/logging.md`), and keeping it out of every annotation is simpler than relying on that.

- [ ] **Step 4: Write `src/server/index.ts`**

```ts
// The server half products import. The hub class is NOT exported here: it
// imports `cloudflare:workers`, which exists only on workerd, and a product
// imports it from `@shared/realtime/hub` in its Worker entry alone.
export type { HubNamespace, HubStub } from "./hub-namespace";
export { REALTIME_METRICS, type PublishResult, type SubscribeOutcome } from "./metrics";
export { publish, PUBLISH_TIMEOUT_MS, type PublishOptions } from "./publish";
export { subscribe, type SubscribeOptions } from "./subscribe";
```

- [ ] **Step 5: Run the tests and the type-check**

Run: `bun run --cwd shared/realtime test:run`
Expected: PASS. Every file so far is green, and `subscribe.test.ts` has 23 cases.

Run: `bun run --cwd shared/realtime check`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add shared/realtime/src/server/headers.ts shared/realtime/src/server/subscribe.ts \
  shared/realtime/src/server/index.ts shared/realtime/tests/server/subscribe.test.ts
git commit -m "Add subscribe(), which admits an upgrade or refuses it with a plain status"
```

---

### Task 5: `TopicHub` on real workerd

**Files:**
- Create: `shared/realtime/src/server/close-reply.ts`
- Create: `shared/realtime/src/server/hub.ts`
- Create: `shared/realtime/tests/d1/fixtures/hub-worker.ts`
- Test: `shared/realtime/tests/server/close-reply.test.ts` (Vitest)
- Test: `shared/realtime/tests/d1/hub.test.ts` (Miniflare)

**Interfaces:**
- Consumes: `PING`, `PONG`, `CLOSE_CODES`, `parseTopic`, `Signal` (Task 1); `metricHubCapacityRefused` (Task 2); `HubNamespace` (Task 3); `subscribe`, `HUB_*_HEADER` (Task 4); `publish` (Task 3)
- Produces: `class TopicHub extends DurableObject<unknown>`, which phase 2 exports from the cire Worker entry. Its members:
  - `static socketCap = 50`, `static subjectCap = 5`, `static staleAfterMs = 75_000`
  - `fetch(request): Response` — accepts an upgrade that carries both hub headers
  - `publish(signal: Signal, evictSubjects?: readonly string[]): number` — an RPC method; returns how many sockets the signal reached
  - `webSocketMessage`, `webSocketClose`, `webSocketError`

Behaviour the tests pin:

- Sockets are tagged `["subject:<subject>"]` only. Each instance holds one topic, so a topic tag would say nothing. Tags are capped at 10 per socket and 256 characters each (https://developers.cloudflare.com/durable-objects/api/state/), so a subject longer than 200 characters is refused with 400, and `subscribe()` turns that into a 503.
- The auto-response pair (`ping` → `pong`) is set in the constructor. The runtime answers it without waking the object (same page: "the auto-response will be returned without waking WebSockets in hibernation and incurring billable duration charges"). It matches only an exact text frame (workerd `legacy-hibernation-manager.c++`).
- Caps count only sockets whose `readyState` is `OPEN`. A socket the hub is already closing does not hold a place.
- When a new socket would put the topic over `socketCap`, or its subject over `subjectCap`, the hub first closes every other socket that has not pinged within `staleAfterMs`, with close code 4002 (`CLOSE_CODES.stale`). It uses `getWebSocketAutoResponseTimestamp`, or the accept time kept in the socket's attachment when the socket has never pinged. Only if the new socket is still over a cap is it closed with 1008. The spec says "over the cap, close with a policy code". This is what stops sockets whose clients vanished without a close frame from filling a topic for good, and it stops one member filling it.
- Any client frame other than `ping` reaches `webSocketMessage` and is closed with 1008, so a chatty client cannot keep the object awake.
- At compatibility date 2025-03-01 the runtime does not answer a client's close. That default arrives with `web_socket_auto_reply_to_close` on 2026-04-07 (https://developers.cloudflare.com/durable-objects/api/base/). So `webSocketClose` calls `ws.close()` itself. A received 1004, 1005, 1006 or 1015 cannot be echoed, because workerd's `close()` throws on those four (workerd `web-socket.c++`), so those become 1000. That mapping is `replyCloseCode` in `close-reply.ts`, a pure function the Vitest tier pins. On a later compatibility date the runtime has already replied, and the second `close` throws and is swallowed.
- **What the Miniflare tier cannot prove:** the reply itself. With the `webSocketClose` body deleted, the close test still passes. On 2026-09-26, Miniflare 4.20260730.0 completed the client's close handshake without it. The Vitest tier pins the code mapping, and phase 2's deploy walk is where a missing reply would surface, as 1006 errors in the browser.

- [ ] **Step 0: Write `src/server/close-reply.ts` and its test**

`shared/realtime/src/server/close-reply.ts`:

```ts
/** Close codes the runtime keeps for itself: `close()` with one of them throws. */
const RESERVED_CLOSE_CODES: ReadonlySet<number> = new Set([1004, 1005, 1006, 1015]);

/**
 * The code a hub answers a client's close with: the client's own code, unless
 * the runtime reserves it — a socket that died without a close frame arrives
 * as 1006, which cannot be sent back — and then 1000.
 */
export const replyCloseCode = (received: number): number =>
  RESERVED_CLOSE_CODES.has(received) ? 1000 : received;
```

`shared/realtime/tests/server/close-reply.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { replyCloseCode } from "../../src/server/close-reply";

describe("replyCloseCode", () => {
  it.each([1004, 1005, 1006, 1015])("answers the reserved code %i with 1000", (code) => {
    expect(replyCloseCode(code)).toBe(1000);
  });

  it.each([1000, 1001, 1008, 4001])("echoes %i", (code) => {
    expect(replyCloseCode(code)).toBe(code);
  });
});
```

Run: `bun run --cwd shared/realtime test:run tests/server/close-reply.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 1: Write the fixture Worker `tests/d1/fixtures/hub-worker.ts`**

```ts
import { Effect } from "effect";

import type { Signal } from "../../../src/protocol";
import { TopicHub } from "../../../src/server/hub";
import type { HubNamespace } from "../../../src/server/hub-namespace";
import { publish } from "../../../src/server/publish";
import { subscribe } from "../../../src/server/subscribe";

/** A hub that counts the frames that woke it, so a test can prove a ping did not. */
export class ObservedHub extends TopicHub {
  private woken = 0;

  override webSocketMessage(ws: WebSocket): void {
    this.woken += 1;
    super.webSocketMessage(ws);
  }

  wakes(): number {
    return this.woken;
  }

  sockets(): number {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).length;
  }
}

/** Two sockets per topic, so the cap is reachable in a test. */
export class SmallHub extends ObservedHub {
  static override socketCap = 2;
}

/** Two sockets per topic, and a socket goes stale after 50 ms without a ping. */
export class StaleHub extends ObservedHub {
  static override socketCap = 2;
  static override staleAfterMs = 50;
}

/** Two sockets per subject. */
export class SubjectHub extends ObservedHub {
  static override subjectCap = 2;
}

interface Env {
  HUB: DurableObjectNamespace<ObservedHub>;
  SMALL_HUB: DurableObjectNamespace<SmallHub>;
  STALE_HUB: DurableObjectNamespace<StaleHub>;
  SUBJECT_HUB: DurableObjectNamespace<SubjectHub>;
}

// Not exported: workerd treats every export of a Worker's main module as an
// entrypoint and refuses to start on one that is not a handler or a class.
const ORIGIN = "https://host.example.test";

function pick(env: Env, name: string | null): DurableObjectNamespace<ObservedHub> {
  if (name === "small") return env.SMALL_HUB;
  if (name === "stale") return env.STALE_HUB;
  if (name === "subject") return env.SUBJECT_HUB;
  return env.HUB;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, action = "", rawTopic = ""] = url.pathname.split("/");
    const namespace = pick(env, url.searchParams.get("hub"));
    // The type-level proof that a real binding satisfies the helpers' shape.
    const hub: HubNamespace = namespace;
    const topic = decodeURIComponent(rawTopic);
    const evict = url.searchParams.getAll("evict");

    if (action === "subscribe") {
      return Effect.runPromise(
        subscribe(request, rawTopic, {
          product: "cire",
          hub,
          allowedOrigins: [ORIGIN],
          acceptsTopic: () => true,
          authenticate: async (req) => req.headers.get("x-test-subject"),
          allow: async () => true,
          authorize: async () => true,
        }),
      );
    }
    if (action === "publish") {
      // Straight to the hub's RPC method, so a test sees how many it reached.
      const signal: Signal = { topic, kind: "members-changed", at: Date.now() };
      return Response.json({ reached: await namespace.getByName(topic).publish(signal, evict) });
    }
    if (action === "helper-publish") {
      await Effect.runPromise(publish(hub, topic, "members-changed", { evictSubjects: evict }));
      return new Response(null, { status: 204 });
    }
    if (action === "raw") {
      // An upgrade without the hub headers, as no product would send it.
      return namespace.getByName(topic).fetch(new Request(url, { headers: { upgrade: "websocket" } }));
    }
    if (action === "stats") {
      const stub = namespace.getByName(topic);
      return Response.json({ sockets: await stub.sockets(), wakes: await stub.wakes() });
    }
    return new Response(null, { status: 404 });
  },
};
```

- [ ] **Step 2: Write the failing test `tests/d1/hub.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Miniflare } from "miniflare";

/**
 * TopicHub on real workerd. The hibernation API — tags, the auto-response,
 * `getWebSockets`, the close handshake — exists only in the runtime, so a
 * stand-in would test the stand-in. Same tier and build recipe as
 * `osn/api/tests/d1/waituntil.test.ts`.
 */

const ORIGIN = "https://host.example.test";
const HOOK_TIMEOUT_MS = 30_000;
let mf: Miniflare;

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [`${import.meta.dirname}/fixtures/hub-worker.ts`],
    format: "esm",
    target: "node",
    // Provided by workerd itself: there is nothing to bundle.
    external: ["cloudflare:workers"],
  });
  if (!built.success) throw new AggregateError(built.logs, "fixture build failed");
  mf = new Miniflare({
    modules: true,
    script: await built.outputs[0]!.text(),
    // cire-api's date and flags (`cire/api/wrangler.toml`): before the
    // runtime answers a close by itself, so the hub's own reply is exercised.
    compatibilityDate: "2025-03-01",
    compatibilityFlags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
    durableObjects: {
      HUB: { className: "ObservedHub", useSQLite: true },
      SMALL_HUB: { className: "SmallHub", useSQLite: true },
      STALE_HUB: { className: "StaleHub", useSQLite: true },
      SUBJECT_HUB: { className: "SubjectHub", useSQLite: true },
    },
  });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await mf?.dispose();
});

const tick = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
const at = (topic: string, action: string, query = "") =>
  `http://hub.example.test/${action}/${encodeURIComponent(topic)}${query}`;

async function open(topic: string, subject: string, query = "") {
  const res = await mf.dispatchFetch(at(topic, "subscribe", query), {
    headers: { Upgrade: "websocket", Origin: ORIGIN, "x-test-subject": subject },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no socket: status ${res.status}`);
  const frames: string[] = [];
  const closes: number[] = [];
  ws.addEventListener("message", (event) => frames.push(String(event.data)));
  ws.addEventListener("close", (event) => closes.push(event.code));
  ws.accept();
  return { ws, frames, closes, status: res.status };
}

async function stats(topic: string, query = "") {
  const res = await mf.dispatchFetch(at(topic, "stats", query));
  return (await res.json()) as { sockets: number; wakes: number };
}

async function publishTo(topic: string, query = "") {
  const res = await mf.dispatchFetch(at(topic, "publish", query));
  return (await res.json()) as { reached: number };
}

describe("TopicHub", () => {
  it("upgrades an admitted request to a 101 with a socket", async () => {
    const socket = await open("cire:wedding:wed_up", "usr_a");
    expect(socket.status).toBe(101);
    expect((await stats("cire:wedding:wed_up")).sockets).toBe(1);
  });

  it("answers ping with pong without waking the hub", async () => {
    const socket = await open("cire:wedding:wed_ping", "usr_a");
    socket.ws.send("ping");
    await tick();
    expect(socket.frames).toEqual(["pong"]);
    expect((await stats("cire:wedding:wed_ping")).wakes).toBe(0);
  });

  it("answers only the exact frame: PING is an unexpected frame", async () => {
    const socket = await open("cire:wedding:wed_shout", "usr_a");
    socket.ws.send("PING");
    await tick();
    expect(socket.frames).toEqual([]);
    expect(socket.closes).toEqual([1008]);
  });

  it("sends a published signal to every socket on the topic and none elsewhere", async () => {
    const a = await open("cire:wedding:wed_pub", "usr_a");
    const b = await open("cire:wedding:wed_pub", "usr_b");
    const other = await open("cire:wedding:wed_other", "usr_a");

    expect(await publishTo("cire:wedding:wed_pub")).toEqual({ reached: 2 });
    await tick();

    for (const socket of [a, b]) {
      expect(socket.frames).toHaveLength(1);
      expect(JSON.parse(socket.frames[0]!)).toMatchObject({
        topic: "cire:wedding:wed_pub",
        kind: "members-changed",
      });
    }
    expect(other.frames).toEqual([]);
  });

  it("evicts only the named subject, after it has the signal", async () => {
    const stays = await open("cire:wedding:wed_evict", "usr_stays");
    const goes = await open("cire:wedding:wed_evict", "usr_goes");

    await publishTo("cire:wedding:wed_evict", "?evict=usr_goes");
    await tick();

    expect(goes.frames).toHaveLength(1);
    expect(goes.closes).toEqual([4001]);
    expect(stays.frames).toHaveLength(1);
    expect(stays.closes).toEqual([]);
  });

  it("reaches nobody on a topic nobody holds", async () => {
    expect(await publishTo("cire:wedding:wed_empty")).toEqual({ reached: 0 });
  });

  it("takes a publish from the shared helper over a real binding", async () => {
    const socket = await open("cire:wedding:wed_helper", "usr_a");
    const res = await mf.dispatchFetch(at("cire:wedding:wed_helper", "helper-publish"));
    await tick();
    expect(res.status).toBe(204);
    expect(socket.frames).toHaveLength(1);
  });

  it("closes the socket over the topic cap with 1008 and keeps the others", async () => {
    const first = await open("cire:wedding:wed_cap", "usr_1", "?hub=small");
    const second = await open("cire:wedding:wed_cap", "usr_2", "?hub=small");
    const third = await open("cire:wedding:wed_cap", "usr_3", "?hub=small");
    await tick();
    expect(first.closes).toEqual([]);
    expect(second.closes).toEqual([]);
    expect(third.closes).toEqual([1008]);
  });

  it("makes room at the cap by closing a socket that stopped pinging", async () => {
    const quiet = await open("cire:wedding:wed_stale", "usr_quiet", "?hub=stale");
    const pinging = await open("cire:wedding:wed_stale", "usr_pinging", "?hub=stale");
    await tick(120);
    pinging.ws.send("ping");
    await tick(20);
    const newcomer = await open("cire:wedding:wed_stale", "usr_new", "?hub=stale");
    await tick();
    expect(quiet.closes).toEqual([4002]);
    expect(pinging.closes).toEqual([]);
    expect(newcomer.closes).toEqual([]);
  });

  it("caps one subject's sockets without refusing anyone else", async () => {
    const one = await open("cire:wedding:wed_subject", "usr_many", "?hub=subject");
    const two = await open("cire:wedding:wed_subject", "usr_many", "?hub=subject");
    const three = await open("cire:wedding:wed_subject", "usr_many", "?hub=subject");
    const someoneElse = await open("cire:wedding:wed_subject", "usr_other", "?hub=subject");
    await tick();
    expect(one.closes).toEqual([]);
    expect(two.closes).toEqual([]);
    expect(three.closes).toEqual([1008]);
    expect(someoneElse.closes).toEqual([]);
  });

  it("closes a socket that sends anything but ping, with 1008", async () => {
    const socket = await open("cire:wedding:wed_chatty", "usr_a");
    socket.ws.send("hello");
    await tick();
    expect(socket.closes).toEqual([1008]);
  });

  it("answers a client's close with its code and forgets the socket", async () => {
    const socket = await open("cire:wedding:wed_bye", "usr_a");
    socket.ws.close(1000, "bye");
    await tick(300);
    expect(socket.closes).toEqual([1000]);
    expect((await stats("cire:wedding:wed_bye")).sockets).toBe(0);
  });

  it("refuses an upgrade that lacks the hub headers", async () => {
    const res = await mf.dispatchFetch(at("cire:wedding:wed_raw", "raw"));
    expect(res.status).toBe(400);
    expect(res.webSocket).toBeFalsy();
  });

  it("refuses a subject too long to tag, so subscribe answers 503", async () => {
    const res = await mf.dispatchFetch(at("cire:wedding:wed_long", "subscribe"), {
      headers: { Upgrade: "websocket", Origin: ORIGIN, "x-test-subject": "u".repeat(201) },
    });
    expect(res.status).toBe(503);
    expect(res.webSocket).toBeFalsy();
  });
});
```

Run: `bun run --cwd shared/realtime test:d1`
Expected: FAIL at `beforeAll`, with the fixture build reporting that it cannot resolve `../../../src/server/hub`.

- [ ] **Step 3: Write `src/server/hub.ts`**

```ts
import { DurableObject } from "cloudflare:workers";

import { CLOSE_CODES, parseTopic, PING, PONG, type RealtimeProduct, type Signal } from "../protocol";
import { replyCloseCode } from "./close-reply";
import { HUB_SUBJECT_HEADER, HUB_TOPIC_HEADER } from "./headers";
import { metricHubCapacityRefused } from "./metrics";

/** The runtime caps a socket tag at 256 characters; the tag is `subject:` plus this. */
const MAX_SUBJECT_LENGTH = 200;

const subjectTag = (subject: string): string => `subject:${subject}`;

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed or closing: there is nothing left to do.
  }
}

/** When the socket was accepted, kept on the socket so it survives hibernation. */
function acceptedAt(ws: WebSocket): number {
  const attachment: unknown = ws.deserializeAttachment();
  return typeof attachment === "object" &&
    attachment !== null &&
    "acceptedAt" in attachment &&
    typeof attachment.acceptedAt === "number"
    ? attachment.acceptedAt
    : 0;
}

/**
 * One topic's open sockets, one instance per topic (`getByName(topic)`).
 *
 * It holds sockets through the hibernation API and nothing else — no storage,
 * no alarm, no timer — so between signals it sleeps and is not billed for
 * duration. The client's `ping` is answered by the runtime's auto-response
 * without waking it. Signals carry no data: a woken hub only forwards
 * "something changed" to every socket on its topic.
 */
export class TopicHub extends DurableObject<unknown> {
  /** Open sockets one topic may hold. A subclass may lower it; the tests do. */
  static socketCap = 50;
  /** Open sockets one subject may hold on a topic, so no member can fill it. */
  static subjectCap = 5;
  /**
   * A socket that has not pinged for this long (or, never having pinged, was
   * accepted this long ago) gives up its place when the topic is full. Three
   * of the client's default 25 s ping intervals; a hidden tab stops pinging, so
   * its socket is the first to go, and it reconnects when shown.
   */
  static staleAfterMs = 75_000;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /**
   * Accept an upgrade that `subscribe()` built. It carries the topic and the
   * admitted subject in headers only a product Worker can set.
   */
  override fetch(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response(null, { status: 426 });
    }
    const parsed = parseTopic(request.headers.get(HUB_TOPIC_HEADER) ?? "");
    const subject = request.headers.get(HUB_SUBJECT_HEADER) ?? "";
    if (!parsed || subject.length === 0 || subject.length > MAX_SUBJECT_LENGTH) {
      return new Response(null, { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [subjectTag(subject)]);
    server.serializeAttachment({ acceptedAt: Date.now() });
    if (this.overCapacity(subject)) {
      this.closeStale(server);
      if (this.overCapacity(subject)) this.refuse(server, parsed.product);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Send `signal` to every socket on the topic, then close each evicted
   * subject's sockets so they reconnect and are checked again. A socket that
   * cannot be written to is closed. Returns how many sockets the signal reached.
   */
  publish(signal: Signal, evictSubjects: readonly string[] = []): number {
    const frame = JSON.stringify(signal);
    let reached = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
        reached += 1;
      } catch {
        closeQuietly(ws, 1011, "send failed");
      }
    }
    for (const subject of evictSubjects) {
      for (const ws of this.ctx.getWebSockets(subjectTag(subject))) {
        closeQuietly(ws, CLOSE_CODES.evicted, "membership changed");
      }
    }
    return reached;
  }

  /**
   * `ping` is the only frame a client may send, and the runtime answers it
   * without calling this. Anything else is closed, so a client cannot keep the
   * hub awake by talking to it.
   */
  override webSocketMessage(ws: WebSocket): void {
    closeQuietly(ws, CLOSE_CODES.policy, "unexpected frame");
  }

  /** Answer the client's close; see {@link replyCloseCode}. */
  override webSocketClose(ws: WebSocket, code: number): void {
    closeQuietly(ws, replyCloseCode(code), "closing");
  }

  override webSocketError(ws: WebSocket): void {
    closeQuietly(ws, 1011, "socket error");
  }

  private open(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private overCapacity(subject: string): boolean {
    const hub = this.constructor as typeof TopicHub;
    return (
      this.open().length > hub.socketCap || this.open(subjectTag(subject)).length > hub.subjectCap
    );
  }

  /** Close every socket but `keep` that has not pinged within `staleAfterMs`. */
  private closeStale(keep: WebSocket): void {
    const staleBefore = Date.now() - (this.constructor as typeof TopicHub).staleAfterMs;
    for (const ws of this.open()) {
      if (ws === keep) continue;
      const lastSeen = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? acceptedAt(ws);
      if (lastSeen < staleBefore) closeQuietly(ws, CLOSE_CODES.stale, "stale");
    }
  }

  private refuse(ws: WebSocket, product: RealtimeProduct): void {
    metricHubCapacityRefused(product);
    closeQuietly(ws, CLOSE_CODES.policy, "topic full");
  }
}
```

- [ ] **Step 4: Run the Miniflare tier and watch it pass**

Run: `bun run --cwd shared/realtime test:d1`
Expected: PASS (14 tests). If Miniflare prints `Uncaught TypeError … createRequire`, the bundle took a CommonJS path. Report it and do not switch `target` blind: `target: "node"` bundled Effect and `@shared/observability` into workerd cleanly in the 2026-09-26 spike.

- [ ] **Step 5: See the guard fail**

Make each change below on its own, run `bun run --cwd shared/realtime test:d1`, see the named test fail, and restore the line before the next. All three were seen failing on 2026-09-26.

| Change | Test that fails |
|---|---|
| `ctx.setWebSocketAutoResponse(...)` → `ctx.setWebSocketAutoResponse()` | "answers ping with pong without waking the hub" |
| delete `this.closeStale(server);` | "makes room at the cap by closing a socket that stopped pinging" |
| delete the `\|\| this.open(subjectTag(subject)).length > hub.subjectCap` clause | "caps one subject's sockets without refusing anyone else" |

- [ ] **Step 6: Type-check and run the whole fast tier**

Run: `bun run --cwd shared/realtime check`
Expected: exit 0. The fixture's `const hub: HubNamespace = namespace` line is the compile-time proof that a real binding satisfies `HubNamespace`.

Run: `bun run --cwd shared/realtime test:run`
Expected: PASS, with `tests/d1/` excluded.

- [ ] **Step 7: Commit**

```bash
git add shared/realtime/src/server/close-reply.ts shared/realtime/src/server/hub.ts \
  shared/realtime/tests/server/close-reply.test.ts shared/realtime/tests/d1
git commit -m "Add TopicHub, the per-topic hibernating Durable Object"
```

---

### Task 6: The browser client

**Files:**
- Create: `shared/realtime/src/client/subscription.ts`
- Create: `shared/realtime/src/client/index.ts`
- Create: `shared/realtime/tests/support/fake-websocket.ts`
- Test: `shared/realtime/tests/client/subscription.test.ts`

**Interfaces:**
- Consumes: `CLOSE_CODES`, `isSignal`, `PING`, `PONG`, `Signal` (Task 1)
- Produces (phase 2's portal relies on these):
  - `type SignalEvent = { reason: "message"; signal: Signal } | { reason: "dropped" } | { reason: "reconnected" } | { reason: "stopped" }`
  - `interface SubscriptionOptions { pingIntervalMs?; maxAttempts?; baseDelayMs?; maxDelayMs?; random?; onFallback?; WebSocket? }`
  - `SUBSCRIPTION_DEFAULTS = { pingIntervalMs: 25_000, maxAttempts: 6, baseDelayMs: 1_000, maxDelayMs: 30_000 } as const`
  - `createTopicSubscription(url: string, onSignal: (event: SignalEvent) => void, options?: SubscriptionOptions): { close(): void }`
  - `@shared/realtime/client` re-exports all of these.

The behaviour to pin:

- The first open is silent. Every later open is `reconnected`.
- An open socket that is lost is `dropped`, and a retry follows. Losses include a close with any code but 1008, and a ping unanswered by the next ping.
- An attempt that never opens is a failure. The retry delay is `random() × min(maxDelayMs, baseDelayMs × 2^(failures−1))` ("full jitter"). After `maxAttempts` consecutive failures, the subscription stops, calls `onFallback` once and holds no timers.
- A 1008 close stops at once, and also calls `onFallback`.
- A subscription that gives up after having been open emits `stopped` once, then calls `onFallback`. A member removed while their socket was down gets `dropped` before the removal. Every reconnect after the removal is refused, and without `stopped` nothing would prompt a re-read.
- A subscriber callback that throws cannot stop the loop: every `onSignal` and `onFallback` call is guarded. A `close()` from inside a callback arms no retry.
- `close()` cancels everything, and a late event from a closed socket does nothing.
- Liveness keys on "the last ping is still unanswered", not on elapsed time. Chrome throttles background-tab timers to about once a minute, which a wall-clock check would read as silence.

- [ ] **Step 1: Write `tests/support/fake-websocket.ts`**

```ts
/**
 * A WebSocket stand-in the client tests drive by hand. Every instance is
 * recorded, so a test can open it, deliver a frame or close it from the
 * "server" side, and see what the client sent.
 */
export class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  static throwOnConstruct = false;

  static reset(): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.throwOnConstruct = false;
  }

  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {
    super();
    if (FakeWebSocket.throwOnConstruct) throw new DOMException("blocked", "SecurityError");
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }

  /** Server side: the handshake completed. */
  serverOpen(): void {
    this.dispatchEvent(new Event("open"));
  }

  /** Server side: a text frame arrives. */
  serverSend(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  /** Server side or network: the socket closed with `code`. */
  serverClose(code = 1006): void {
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}

/** The constructor type the client's `WebSocket` option takes. */
export const FakeSocketClass = FakeWebSocket as unknown as new (url: string) => WebSocket;

export const latest = (): FakeWebSocket => {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("no socket was opened");
  return socket;
};
```

- [ ] **Step 2: Write the failing test `tests/client/subscription.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTopicSubscription, type SignalEvent } from "../../src/client/subscription";
import { FakeSocketClass, FakeWebSocket, latest } from "../support/fake-websocket";

const URL = "wss://api.example.test/realtime/cire%3Awedding%3Awed_1";
const SIGNAL = JSON.stringify({ topic: "cire:wedding:wed_1", kind: "members-changed", at: 1 });

const base = {
  WebSocket: FakeSocketClass,
  pingIntervalMs: 1_000,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  maxAttempts: 3,
  random: () => 0.5,
};

let events: SignalEvent[];
const onSignal = (event: SignalEvent) => events.push(event);

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  events = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createTopicSubscription", () => {
  it("opens one socket to the URL and says nothing on the first open", () => {
    createTopicSubscription(URL, onSignal, base);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(latest().url).toBe(URL);
    latest().serverOpen();
    expect(events).toEqual([]);
  });

  it("passes a well-formed signal on", () => {
    createTopicSubscription(URL, onSignal, base);
    latest().serverOpen();
    latest().serverSend(SIGNAL);
    expect(events).toEqual([{ reason: "message", signal: JSON.parse(SIGNAL) }]);
  });

  it.each([
    ["pong", "pong"],
    ["text that is not JSON", "{nope"],
    ["JSON that is not a signal", JSON.stringify({ hello: 1 })],
    ["a signal of an unknown kind", JSON.stringify({ topic: "cire:wedding:wed_1", kind: "rows", at: 1 })],
  ])("ignores %s", (_label, frame) => {
    createTopicSubscription(URL, onSignal, base);
    latest().serverOpen();
    latest().serverSend(frame);
    expect(events).toEqual([]);
  });

  it("pings each interval while answered", () => {
    createTopicSubscription(URL, onSignal, base);
    const socket = latest();
    socket.serverOpen();
    vi.advanceTimersByTime(1_000);
    expect(socket.sent).toEqual(["ping"]);
    socket.serverSend("pong");
    vi.advanceTimersByTime(1_000);
    expect(socket.sent).toEqual(["ping", "ping"]);
    expect(events).toEqual([]);
  });

  it("drops a socket whose ping went unanswered, and reconnects", () => {
    createTopicSubscription(URL, onSignal, base);
    const first = latest();
    first.serverOpen();
    vi.advanceTimersByTime(1_000); // ping sent
    vi.advanceTimersByTime(1_000); // still unanswered: dead
    expect(first.closedWith).not.toBeNull();
    expect(events).toEqual([{ reason: "dropped" }]);

    first.serverClose(1006); // the late close of the abandoned socket changes nothing
    expect(events).toEqual([{ reason: "dropped" }]);

    vi.advanceTimersByTime(50); // 0.5 × min(1000, 100 × 2^0)
    expect(FakeWebSocket.instances).toHaveLength(2);
    latest().serverOpen();
    expect(events).toEqual([{ reason: "dropped" }, { reason: "reconnected" }]);
  });

  it("treats a lost open socket as a signal, then a successful reconnect as another", () => {
    createTopicSubscription(URL, onSignal, base);
    latest().serverOpen();
    latest().serverClose(1006);
    expect(events).toEqual([{ reason: "dropped" }]);
    vi.advanceTimersByTime(50);
    latest().serverOpen();
    expect(events).toEqual([{ reason: "dropped" }, { reason: "reconnected" }]);
  });

  it("reconnects after an eviction (4001)", () => {
    createTopicSubscription(URL, onSignal, base);
    latest().serverOpen();
    latest().serverClose(4001);
    expect(events).toEqual([{ reason: "dropped" }]);
    vi.advanceTimersByTime(50);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("backs off within the ceiling and falls back after maxAttempts failed attempts", () => {
    const onFallback = vi.fn();
    createTopicSubscription(URL, onSignal, { ...base, random: () => 0.999, onFallback });

    latest().serverClose(1006); // attempt 1 never opened
    vi.advanceTimersByTime(98);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1); // floor(0.999 × 100) = 99
    expect(FakeWebSocket.instances).toHaveLength(2);

    latest().serverClose(1006); // attempt 2
    vi.advanceTimersByTime(199); // floor(0.999 × 200)
    expect(FakeWebSocket.instances).toHaveLength(3);

    latest().serverClose(1006); // attempt 3 = maxAttempts
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(events).toEqual([]);
  });

  it("never waits longer than maxDelayMs", () => {
    createTopicSubscription(URL, onSignal, { ...base, maxAttempts: 10, random: () => 0.999 });
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      latest().serverClose(1006);
      vi.advanceTimersByTime(999);
      expect(FakeWebSocket.instances).toHaveLength(attempt + 1);
    }
  });

  it("stops at once on 1008 — the topic is full or a frame was refused", () => {
    const onFallback = vi.fn();
    createTopicSubscription(URL, onSignal, { ...base, onFallback });
    latest().serverOpen();
    latest().serverClose(1008);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ reason: "stopped" }]);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("prompts one last re-read when it gives up after having been open", () => {
    const onFallback = vi.fn();
    createTopicSubscription(URL, onSignal, { ...base, onFallback });
    latest().serverOpen();
    latest().serverClose(1006); // open socket lost: dropped
    for (let attempt = 0; attempt < 3; attempt += 1) {
      vi.advanceTimersByTime(1_000);
      latest().serverClose(1006); // every reconnect refused
    }
    expect(events).toEqual([{ reason: "dropped" }, { reason: "stopped" }]);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps reconnecting when the subscriber throws", () => {
    createTopicSubscription(
      URL,
      () => {
        throw new Error("subscriber bug");
      },
      base,
    );
    latest().serverOpen();
    latest().serverClose(1006);
    vi.advanceTimersByTime(50);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("arms no retry when the subscriber closes the subscription from inside a signal", () => {
    const holder: { subscription?: { close(): void } } = {};
    holder.subscription = createTopicSubscription(URL, () => holder.subscription?.close(), base);
    latest().serverOpen();
    latest().serverClose(1006);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("counts a constructor that throws (a blocked URL) as a failed attempt", () => {
    const onFallback = vi.fn();
    FakeWebSocket.throwOnConstruct = true;
    createTopicSubscription(URL, onSignal, { ...base, onFallback });
    vi.advanceTimersByTime(10_000);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close() cancels its timers and closes the socket with 1000", () => {
    const subscription = createTopicSubscription(URL, onSignal, base);
    const socket = latest();
    socket.serverOpen();
    subscription.close();
    expect(socket.closedWith?.code).toBe(1000);
    expect(vi.getTimerCount()).toBe(0);
    socket.serverSend(SIGNAL);
    socket.serverClose(1006);
    expect(events).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("close() during a retry wait cancels the retry", () => {
    const subscription = createTopicSubscription(URL, onSignal, base);
    latest().serverClose(1006);
    subscription.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
```

Run: `bun run --cwd shared/realtime test:run tests/client/subscription.test.ts`
Expected: FAIL, because `../../src/client/subscription` does not resolve.

- [ ] **Step 3: Write `src/client/subscription.ts`**

```ts
import { CLOSE_CODES, isSignal, PING, PONG, type Signal } from "../protocol";

/**
 * Why the subscriber should read again: a signal arrived; an open socket was
 * lost (a change may land while it is down); a socket reopened after a loss
 * (a change may have landed meanwhile); or the subscription gave up after
 * having been open (a member removed while their socket was down is refused
 * on every reconnect, and this is their last prompt to re-read).
 */
export type SignalEvent =
  | { readonly reason: "message"; readonly signal: Signal }
  | { readonly reason: "dropped" }
  | { readonly reason: "reconnected" }
  | { readonly reason: "stopped" };

export interface SubscriptionOptions {
  /** How often an open socket sends `ping`. A ping unanswered by the next one marks the socket dead. */
  readonly pingIntervalMs?: number;
  /** Consecutive attempts that never open before the subscription gives up. */
  readonly maxAttempts?: number;
  /** Ceiling of the first retry's delay; each further failure doubles it, up to `maxDelayMs`. */
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Jitter source in [0, 1). */
  readonly random?: () => number;
  /** Called once when the subscription gives up for good. */
  readonly onFallback?: () => void;
  /** The WebSocket constructor; tests pass a stand-in. */
  readonly WebSocket?: new (url: string) => WebSocket;
}

export interface TopicSubscription {
  /** Close the socket and cancel every timer. Safe to call more than once. */
  close(): void;
}

export const SUBSCRIPTION_DEFAULTS = {
  pingIntervalMs: 25_000,
  maxAttempts: 6,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
} as const;

/**
 * Hold one socket open to `url` and call `onSignal` whenever the subscriber
 * should re-read. It reconnects with capped, jittered backoff, and after
 * `maxAttempts` consecutive failed attempts it stops and calls `onFallback`
 * once, leaving the product's own refetch triggers as the only ones. It never
 * throws and never logs: a browser that cannot hold the socket behaves exactly
 * as one without push.
 */
export function createTopicSubscription(
  url: string,
  onSignal: (event: SignalEvent) => void,
  options: SubscriptionOptions = {},
): TopicSubscription {
  const pingIntervalMs = options.pingIntervalMs ?? SUBSCRIPTION_DEFAULTS.pingIntervalMs;
  const maxAttempts = options.maxAttempts ?? SUBSCRIPTION_DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? SUBSCRIPTION_DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? SUBSCRIPTION_DEFAULTS.maxDelayMs;
  const random = options.random ?? Math.random;
  const Socket = options.WebSocket ?? globalThis.WebSocket;

  let socket: WebSocket | null = null;
  let failures = 0;
  let everOpened = false;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  function stopPinging(): void {
    if (pingTimer !== undefined) clearInterval(pingTimer);
    pingTimer = undefined;
  }

  function stop(): void {
    stopped = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    stopPinging();
    const current = socket;
    socket = null;
    if (current) {
      try {
        current.close(1000, "done");
      } catch {
        // Already closing: nothing left to release.
      }
    }
  }

  /** Hand `event` to the subscriber. A subscriber that throws cannot stop the reconnect loop. */
  function emit(event: SignalEvent): void {
    try {
      onSignal(event);
    } catch {
      // The subscriber's own failure; the subscription carries on.
    }
  }

  function fallBack(): void {
    stop();
    if (everOpened) emit({ reason: "stopped" });
    try {
      options.onFallback?.();
    } catch {
      // As for onSignal: nothing is left running to protect.
    }
  }

  function retry(): void {
    if (stopped) return;
    if (failures >= maxAttempts) {
      fallBack();
      return;
    }
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, failures - 1));
    retryTimer = setTimeout(connect, Math.floor(random() * ceiling));
  }

  /** `ws` is gone — closed, or abandoned as silent. A no-op for any other socket. */
  function lost(ws: WebSocket, opened: boolean, code: number | undefined): void {
    if (socket !== ws) return;
    socket = null;
    stopPinging();
    if (stopped) return;
    if (code === CLOSE_CODES.policy) {
      fallBack();
      return;
    }
    if (opened) emit({ reason: "dropped" });
    else failures += 1;
    retry();
  }

  function connect(): void {
    retryTimer = undefined;
    if (stopped) return;
    let ws: WebSocket;
    try {
      ws = new Socket(url);
    } catch {
      // A URL the browser refuses outright, or a policy that blocks it.
      failures += 1;
      retry();
      return;
    }
    socket = ws;
    let opened = false;
    let pingOutstanding = false;

    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      const reconnected = everOpened;
      everOpened = true;
      failures = 0;
      pingTimer = setInterval(() => {
        if (pingOutstanding) {
          lost(ws, true, undefined);
          try {
            ws.close();
          } catch {
            // Closing a dead socket can throw; it is already abandoned.
          }
          return;
        }
        pingOutstanding = true;
        try {
          ws.send(PING);
        } catch {
          // The close event that follows handles it.
        }
      }, pingIntervalMs);
      if (reconnected) emit({ reason: "reconnected" });
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      if (socket !== ws) return;
      pingOutstanding = false;
      if (typeof event.data !== "string" || event.data === PONG) return;
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (isSignal(frame)) emit({ reason: "message", signal: frame });
    });

    ws.addEventListener("close", (event: CloseEvent) => lost(ws, opened, event.code));
  }

  connect();
  return { close: stop };
}
```

`src/client/index.ts`:

```ts
export {
  createTopicSubscription,
  SUBSCRIPTION_DEFAULTS,
  type SignalEvent,
  type SubscriptionOptions,
  type TopicSubscription,
} from "./subscription";
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun run --cwd shared/realtime test:run tests/client/subscription.test.ts`
Expected: PASS (19 tests). Deleting the `stopped` emit, the `emit` guard or the `if (stopped) return;` in `retry` each fails at least one of them, as seen on 2026-09-26.

- [ ] **Step 5: Type-check**

Run: `bun run --cwd shared/realtime check`
Expected: exit 0. `tsconfig.client.json` checks the client under the DOM lib.

- [ ] **Step 6: Commit**

```bash
git add shared/realtime/src/client/subscription.ts shared/realtime/src/client/index.ts \
  shared/realtime/tests/support/fake-websocket.ts shared/realtime/tests/client/subscription.test.ts
git commit -m "Add the browser subscription: reconnect as a signal, bounded backoff, fallback"
```

---

### Task 7: `useTopic` — the Solid wrapper

**Files:**
- Create: `shared/realtime/src/client/solid.ts`
- Test: `shared/realtime/tests/client/solid.test.ts`

**Interfaces:**
- Consumes: `createTopicSubscription`, `SignalEvent`, `SubscriptionOptions` (Task 6)
- Produces: `useTopic(url: Accessor<string | null | undefined>, onSignal: (event: SignalEvent) => void, options?: SubscriptionOptions): void`. It opens a socket while `url()` names one, closes it when the URL changes, becomes null/undefined or the owner is disposed, and keeps the socket when the accessor re-runs to the same string. Phase 2 relies on that last property: a wedding rename re-runs the accessor, but the URL does not change.

- [ ] **Step 1: Write the failing test `tests/client/solid.test.ts`**

```ts
// @vitest-environment happy-dom
import { createRoot, createSignal } from "solid-js";
import { beforeEach, describe, expect, it } from "vitest";

import { useTopic } from "../../src/client/solid";
import type { SignalEvent } from "../../src/client/subscription";
import { FakeSocketClass, FakeWebSocket } from "../support/fake-websocket";

const A = "wss://api.example.test/realtime/cire%3Awedding%3Awed_a";
const B = "wss://api.example.test/realtime/cire%3Awedding%3Awed_b";

beforeEach(() => FakeWebSocket.reset());

function mount(initial: string | null) {
  const events: SignalEvent[] = [];
  let setUrl!: (value: string | null) => void;
  let setTick!: (value: number) => void;
  const dispose = createRoot((disposeRoot) => {
    const [url, writeUrl] = createSignal<string | null>(initial);
    const [tick, writeTick] = createSignal(0);
    setUrl = writeUrl;
    setTick = writeTick;
    // Reads `tick` so a test can re-run the accessor without changing its value.
    useTopic(() => (tick() >= 0 ? url() : null), (event) => events.push(event), {
      WebSocket: FakeSocketClass,
    });
    return disposeRoot;
  });
  return { events, setUrl, setTick, dispose };
}

describe("useTopic", () => {
  it("opens a socket for the URL", () => {
    mount(A);
    expect(FakeWebSocket.instances.map((socket) => socket.url)).toEqual([A]);
  });

  it("opens nothing while the URL is null", () => {
    mount(null);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("closes the old socket and opens a new one when the URL changes", () => {
    const { setUrl } = mount(A);
    setUrl(B);
    expect(FakeWebSocket.instances.map((socket) => socket.url)).toEqual([A, B]);
    expect(FakeWebSocket.instances[0]?.closedWith?.code).toBe(1000);
  });

  it("keeps the socket when the accessor re-runs to the same URL", () => {
    const { setTick } = mount(A);
    setTick(1);
    setTick(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.closedWith).toBeNull();
  });

  it("closes the socket when the URL becomes null", () => {
    const { setUrl } = mount(A);
    setUrl(null);
    expect(FakeWebSocket.instances[0]?.closedWith?.code).toBe(1000);
  });

  it("closes the socket when its owner is disposed", () => {
    const { dispose } = mount(A);
    dispose();
    expect(FakeWebSocket.instances[0]?.closedWith?.code).toBe(1000);
  });

  it("forwards the subscription's events", () => {
    const { events } = mount(A);
    const socket = FakeWebSocket.instances[0]!;
    socket.serverOpen();
    socket.serverSend(JSON.stringify({ topic: "cire:wedding:wed_a", kind: "members-changed", at: 1 }));
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("message");
  });
});
```

Run: `bun run --cwd shared/realtime test:run tests/client/solid.test.ts`
Expected: FAIL, because `../../src/client/solid` does not resolve.

- [ ] **Step 2: Write `src/client/solid.ts`**

```ts
import { type Accessor, createEffect, createMemo, on, onCleanup } from "solid-js";

import {
  createTopicSubscription,
  type SignalEvent,
  type SubscriptionOptions,
} from "./subscription";

/**
 * Keep one socket open to `url()` while it names one. The socket closes when
 * the URL changes, becomes null, or the owner is disposed. An accessor that
 * re-runs to the same string keeps the socket it has — the memo compares the
 * string, not whatever the accessor read to build it.
 */
export function useTopic(
  url: Accessor<string | null | undefined>,
  onSignal: (event: SignalEvent) => void,
  options?: SubscriptionOptions,
): void {
  const target = createMemo(() => url() ?? null);
  createEffect(
    on(target, (current) => {
      if (current === null) return;
      const subscription = createTopicSubscription(current, onSignal, options);
      onCleanup(() => subscription.close());
    }),
  );
}
```

- [ ] **Step 3: Run the tests and watch them pass**

Run: `bun run --cwd shared/realtime test:run`
Expected: PASS. Every Vitest file is green, and `solid.test.ts` has 7 cases.

- [ ] **Step 4: Type-check**

Run: `bun run --cwd shared/realtime check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add shared/realtime/src/client/solid.ts shared/realtime/tests/client/solid.test.ts
git commit -m "Add useTopic, the Solid wrapper for a topic subscription"
```

---

### Task 8: Wiki, changeset and the gates

**Files:**
- Create: `wiki/shared/realtime.md`
- Modify: `wiki/shared/free-tier-limits.md` (new Durable Objects section; Workers table rows; playbook row; `last-reviewed`)
- Modify: `wiki/shared/observability/metrics.md` (namespace list; single-definition-site table)
- Modify: `wiki/shared/monorepo-structure.md` (frontmatter `packages`; `shared/` tree line)
- Modify: `wiki/index.md` (one line under the shared section, beside `[[toast]]`)
- Create: `.changeset/shared-realtime-package.md`

**Interfaces:** none; documentation only.

- [ ] **Step 1: Load the skills**

Invoke `write-wiki`, then `obsidian:obsidian-markdown`.

- [ ] **Step 2: Write `wiki/shared/realtime.md`**

```markdown
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
last-reviewed: <today>
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
| The browser cannot connect at all | After 6 consecutive failed attempts (at most 1 + 2 + 4 + 8 + 16 = 31 s of waiting, plus connect time) the client stops. If the socket had been open, it emits one last `stopped` signal first. The product's existing refetch triggers remain. |

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
```

Replace `<today>` with the date the task is done.

- [ ] **Step 3: Add the Durable Object limits to `wiki/shared/free-tier-limits.md`**

(a) In the **Cloudflare Workers (Free)** table, after the "Subrequests to CF services" row, add:

```markdown
| WebSocket connections | each connection to a Worker is **one request**; messages over it are **not** requests |
```

Source line, in the section's **Source** list: `[workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)` — "WebSocket connections made to a Worker are charged as a request … WebSocket messages routed through a Worker do not count as requests."

(b) Insert a new section after "Cloudflare Workers (Free)" and before "Cloudflare D1 (Free)":

```markdown
## Cloudflare Durable Objects (Free)

**Source:** [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) · [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) · [state API](https://developers.cloudflare.com/durable-objects/api/state/) · [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) — re-verify.

Durable Objects run on Workers Free since 2025-04-07, **SQLite storage backend only**. `@shared/realtime`'s `TopicHub` is the one class we run ([[realtime]]).

| Limit | Free value (re-verify) |
|---|---|
| Requests | **100,000 / day** |
| Duration | **13,000 GB-s / day** — billed at 128 MB per awake object, so about 101,000 awake-object-seconds a day (13,000 ÷ 0.128) |
| SQLite rows read / written | 5,000,000 / 100,000 per day |
| SQLite storage | 5 GB total |
| Classes per account | 100 |
| WebSocket connections per object | 32,768 |
| Received WebSocket message | 32 MiB |

**What counts.** A request "Includes HTTP requests, RPC sessions, WebSocket messages, and alarm invocations". Creating a WebSocket connection is one request, and every RPC call on a stub (the hub's `publish`) is one. "There is no charge for outgoing WebSocket messages, nor for incoming WebSocket protocol pings."

The client's `ping` is an application text frame, not a protocol ping. The page says only this about it: "Application level auto-response messages handled by state.setWebSocketAutoResponse() will not incur additional wall-clock time, and so they will not be charged". It does not say whether that sentence covers the request count. The 20:1 ratio for incoming messages is stated "for compute requests billing-only", and the page does not say whether it applies on Free.

So a tab's pings cost somewhere between nothing and one request each. At the client's 25 s interval, a visible tab open for 8 hours sends 1,152 pings. That is 0 requests, 58 at 20:1, or 1,152 at 1:1. Measure it on the dev tier before relying on any of the three.

**What keeps an object awake.** A pending `setTimeout`/`setInterval` stops hibernation. An object with no WebSocket and no work is evicted after 70–140 s. One with hibernatable sockets hibernates after 10 s of inactivity. `TopicHub` holds no timer, alarm or storage write.

**What happens at the cap.** "Further operations of that type will fail with an error" until the reset at **00:00 UTC**. A subscribe then answers 503 and the client falls back. A publish logs and counts an error, and the write that called it succeeds. The docs do not say which error a WebSocket upgrade sees.

**How to detect:** CF dashboard → Workers & Pages → Durable Objects → the namespace's requests and duration against the daily lines. The allowance is account-wide, so the dev tier's hubs spend it too. `scripts/check-free-tier-ceilings.ts` does not watch Durable Objects yet. (`realtime.subscribe.attempts{outcome="unavailable"}` would show it, but metrics are not exported from workerd today.)

**Upgrade path:** Workers Paid ($5/mo) lifts these to paid allowances with no code change.
```

(c) In the **Unavailability response playbook** table, add a row:

```markdown
| **Durable Objects** over daily quota | realtime push (`@shared/realtime`) | **fail-SOFT** — `subscribe()` answers 503, `publish()` logs and counts `result="error"` (`shared/realtime/src/server/subscribe.ts`, `publish.ts`) | Tabs stop receiving push and refetch on focus or next request, as before push existed | DO requests/duration vs the daily line in the dashboard (the realtime counters are not exported from workerd yet) | Wait for the UTC reset, or upgrade to Workers Paid. |
```

(d) Add `"[[realtime]]"` to the frontmatter `related` list, and set `last-reviewed` to today.

The dependency map row ("who depends on what") stays unchanged until a product binds the hub. Phase 2 adds `cire-api` there.

- [ ] **Step 4: Register the metric namespace in `wiki/shared/observability/metrics.md`**

- In the **namespace** bullet, add `realtime` to the list: `osn`, `pulse`, `zap`, `arc`, `realtime`, `db`, `http`, `process`.
- In the **Single-definition-site rule** table, add the row `| shared/realtime/src/server/metrics.ts | Realtime push: subscribe outcomes, signals published, hub capacity refusals |`.
- Add `"@shared/realtime"` to the frontmatter `packages` list, and set `last-reviewed` to today.

- [ ] **Step 5: Register the package in `wiki/shared/monorepo-structure.md` and `wiki/index.md`**

- `monorepo-structure.md`: add `  - "@shared/realtime"` to the frontmatter `packages` list, keeping alphabetical order between `@shared/rate-limit` and `@shared/redis` if the list is sorted. In the `shared/` tree, add the line `  realtime/            # @shared/realtime — invalidation signals over WebSocket: the per-topic Durable Object hub, publish/subscribe helpers, the browser client and useTopic`. Set `last-reviewed` to today.
- `wiki/index.md`: in the shared section, beside `- [[toast]] — …`, add `- [[realtime]] — \`@shared/realtime\`: invalidation signals over WebSocket, the per-topic Durable Object hub, and how a product adopts it`.

- [ ] **Step 6: Write the changeset `.changeset/shared-realtime-package.md`**

```markdown
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
```

- [ ] **Step 7: Run every gate and record the real output**

Run each from the repo root and paste the tail of each output into the PR's test plan. A gate you did not run is `NOT RUN`.

```bash
bun install --frozen-lockfile && git diff --stat origin/main...HEAD -- bun.lock
bun run --cwd shared/realtime check
bun run --cwd shared/realtime test:run
bun run --cwd shared/realtime test:d1
bun run check:jest-dom-markers
bun run lint
bun run fmt:check
git diff --name-only origin/main...HEAD | bash scripts/changeset-required.sh
./scripts/validate-changesets.sh
```

Expected results:

- The install prints no changes, and `bun.lock` shows +26 lines.
- `check` exits 0.
- `test:run` passes all 7 Vitest files: protocol (23), metrics (2), close-reply (8), publish (7), subscribe (23), subscription (19), solid (7).
- `test:d1` passes 14 tests.
- The markers check counts one more Solid config.
- `lint` shows no new warnings: compare the count with `origin/main`'s.
- `fmt:check` is clean.
- The changeset script answers `required`, and a changeset is present.
- `validate-changesets.sh` passes.

- [ ] **Step 8: Commit**

```bash
git add wiki/shared/realtime.md wiki/shared/free-tier-limits.md wiki/shared/observability/metrics.md \
  wiki/shared/monorepo-structure.md wiki/index.md .changeset/shared-realtime-package.md
git commit -m "Document @shared/realtime and the Durable Object limits it runs within"
```

---

## Free-plan fit (for the reviewer)

Every figure below is a documented ceiling or arithmetic on one. None is measured.

- **Per event cost.**
  - A connect costs 1 Worker request, 1 DO request, and the product's session and membership reads.
  - A publish costs 1 DO request.
  - An idle hub costs no duration: it hibernates.
  - A ping costs no duration. Whether it costs a request is not stated; see "What counts" in Task 8, Step 3.
- **Headroom, connects and publishes.** At 200 organisers × 20 socket opens a day (page loads, wedding switches, a reconnect after each deploy), that is 4,000 DO requests plus a few hundred publishes. It is also 4,000 Worker requests.
- **Headroom, pings.** Take the same 200 organisers with one visible tab for 8 hours a day. That is 230,400 pings a day, which costs:
  - 0 DO requests if an auto-response is free;
  - 11,520 at 20:1;
  - 230,400 at 1:1, over the 100,000 cap.

  In the last case the hubs start failing mid-day. Subscribes answer 503 and clients fall back to today's behaviour, which is the degradation the spec accepts (decision 2), but push stops for everyone until 00:00 UTC.
- **The allowance is shared.** The 100,000 Worker and DO requests a day are account-wide, across osn-api, cire-api, both dev Workers and the invites Workers (`wiki/shared/free-tier-limits.md`, Workers section). Every figure above lands on top of today's traffic, which `scripts/check-free-tier-ceilings.ts` reports.
- **Duration.** A hub is awake only while it accepts a socket or publishes. The Free allowance is about 101,000 awake-object-seconds a day.
- **What decides it: a measurement gate.** Phase 2's Task 8 deploy walk reads the dev tier's DO **requests** and duration, per open tab-hour, before production. If pings are billed, the owner chooses a remedy before promotion (Open question 2).
- **One risk to watch.** A third-party report (https://github.com/andtii/agentic/issues/351) describes exhausting the Free duration allowance within hours despite hibernation, cause unknown. `TopicHub` has none of the known wake-keepers: no timer, alarm or storage write, and non-`ping` frames are closed.

## Open questions

1. **Client fallback metric.** The spec says the client "records one fallback metric". No browser metric channel exists: Grafana Faro is named in `wiki/shared/observability/overview.md` but wired nowhere (no `faro` import in any package), and `@shared/observability` metrics need an OpenTelemetry SDK that no frontend loads. This plan exposes `onFallback` and records nothing. **Owner:** accept that until browser telemetry exists (file a deferral issue), or ask for a small beacon endpoint per product. Nothing in this plan blocks on the answer.
2. **Are the client's pings billed?** The pricing page does not say (Task 8, Step 3). If the dev-tier measurement shows they are, the remedies are:
   - lengthen `pingIntervalMs`. Cloudflare closes a WebSocket after an idle period that https://developers.cloudflare.com/network/websockets/ does not state, so this needs its own measurement;
   - close the socket while the tab is hidden and reopen it when shown;
   - move to Workers Paid.

   **Owner:** choose, if the measurement says so.
3. **Rollout step 3 (osn) has no browser auth for a socket.** osn's organisation routes take only `Authorization: Bearer` (`osn/api/src/routes/organisation.ts:36-38`), and a browser WebSocket cannot send that header. The spec rules out tickets (decision 3). This plan therefore leaves `"osn"` out of `REALTIME_PRODUCTS`. **Owner:** decide how step 3 authenticates a socket before it is planned. One option is the `__Host-osn_session` cookie on osn-api's own origin (`osn/api/src/lib/cookie-session.ts`); another is to amend decision 3.

## Stress-plan findings (attacker, 2026-09-26) and how each was closed

The plan's code was also run end to end in a throwaway worktree before the attack. That run found and fixed 4 defects, listed under "Evidence this plan's code runs".

| # | Finding | Outcome |
|---|---|---|
| 1 | "A ping costs nothing" is unsupported; pings may be billed requests | **Fixed.** The claim is gone. The pricing text is quoted verbatim, the fit gives 0 / 20:1 / 1:1 figures, the shared allowance is stated, and a dev-tier measurement gates production (Open question 2). |
| 2 | Two lint errors (`Record<string, unknown>`, `Promise<unknown>`) | **Fixed** before the attack, by the execution run. |
| 3 | `dropped` does not cover a removal during an outage | **Fixed.** A new `stopped` signal is emitted when a subscription that had been open gives up. Tested. |
| 4 | A throwing `onSignal` kills the loop | **Fixed.** Every callback is guarded, and `retry` checks `stopped`. Two tests were added; both fail without the fix. |
| 5 | Dead sockets fill the cap, and 1008 is final | **Fixed.** Caps count only `OPEN` sockets, and stale sockets (no ping for 75 s) are closed with 4002 before anyone is refused. Tested, with a red check. |
| 6 | Promised tests missing (1006 reply, long subject, exact frame) | **Fixed.** `replyCloseCode` is unit-tested, and the long-subject (→ 503) and `PING` (→ 1008) tests were added. |
| 7 | Tests that pass with their code deleted | **Partly fixed.** The empty-topic test now asserts `reached: 0` through the RPC, and the helper publish has its own test. **Rejected for the close reply and the capacity metric:** Miniflare completes the close handshake without the hub's reply (measured), and metrics inside workerd write to a no-op meter no test can read. Both limits are stated in Task 5. |
| 8 | Inline publish delays the write | **Fixed** in the adoption guide (publish in `waitUntil`), and in phase 2 Task 5 with a test that fails without it. |
| 9 | The spec's premise fails for osn | **Escalated.** `"osn"` was removed from `REALTIME_PRODUCTS`; Open question 3. |
| 10 | The headroom ignores the shared account-wide quota | **Fixed** in "Free-plan fit". |
| 11 | "About a minute" is wrong; the playbook cites an unexported metric | **Fixed.** Now 31 s, and the metric is marked as not exported. |
| 12 | Unused fixture export | **Fixed** before the attack. The export also crashed workerd. |
| 13 | Unauthenticated flood skips the rate limit | **Rejected.** It is the same order every cire organiser route uses: `osnAuth` before `rateLimitMiddlewareByUser` (`cire/api/src/routes/organiser-hosts.ts:172-177`). A per-IP pre-limit would be a change to all of them, not to this one. |
| 14 | Unbounded entity length; redundant topic tag | **Fixed.** Entity `{1,32}`, and the topic tag is dropped. |
| 15 | Three signals per eviction | **Rejected as a code change.** The re-roled member re-reads three times, once each; everyone else once. It is documented in the wiki page. Suppressing `dropped` after a 4001 would reopen the gap finding 3 closed. |
| 16 | Wiki cites source files in backticks | **Fixed.** Relative links in `wiki/shared/realtime.md`. |
