# Realtime push, phase 2 — cire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cire co-host who is removed or re-roled sees the change in every open organiser-portal tab within seconds, without touching the tab. The API publishes `members-changed` on `cire:wedding:<weddingId>` after each co-host write. The portal listens on the open wedding's topic and re-reads the wedding list when a signal arrives.

**Architecture:** cire-api binds `@shared/realtime`'s `TopicHub` as `REALTIME_HUB`, exported from a new Worker entry module, `src/entry.ts`. The Worker answers `GET /realtime/:topic` **before** the Elysia app, inside the same D1 session. The route uses the shared `subscribe()` with cire's own pieces: the session resolution from `osnAuth`, the per-organiser limiter, and the `member` capability check that `weddingMember()` makes. The three co-host write routes publish through a small `WeddingSignals` service. The host portal's `Dashboard` calls `useTopic` for the open wedding. Every signal runs the existing `recheckWeddings`, whose answer already drops the rows of a wedding the organiser lost.

**Tech Stack:** Cloudflare Workers + Durable Objects (wrangler 4.127.1), Elysia 1.4.30, Effect v4, Drizzle over D1/bun:sqlite, `bun test` (cire/api), SolidJS + Astro + Vitest 4 with happy-dom and real Chromium (cire/host).

**Spec:** `docs/superpowers/specs/2026-09-26-realtime-push-design.md`, §"Per product" and §"cire (first consumer)".
**Depends on:** phase 1, `docs/superpowers/plans/2026-09-26-realtime-phase1-shared-package.md`. It must be merged, or this branch stacked on it (`wiki/conventions/stacked-prs.md`). Every `@shared/realtime` name used below is defined there.

## Global Constraints

Every task's requirements include this section.

- **Tests live in `tests/` at each package root, mirroring `src/`.** cire/api runs `bun test --preload ./tests/test-helpers/metrics-harness.ts` (`cire/api/package.json` `test`), and every file there imports `bun:test`. cire/host has two Vitest projects: `unit` (`environment: "node"`, with component files opting into happy-dom through a `// @vitest-environment happy-dom` first line, `*.test.tsx`) and `browser` (real Chromium, `*.browser.test.tsx`) (`cire/host/vitest.config.ts`).
- **Effect** (AGENTS.md, and `wiki/shared/backend-patterns.md`): cire/api runs Effects through `runCire`, the module-scope `ManagedRuntime` in `cire/api/src/observability.ts`. It provides services with `Effect.provideService(DbService, db)` exactly as the existing routes do. Never `Effect.provide` a layer inside a request. The host portal uses no Effect.
- **Observability** (`wiki/shared/observability/overview.md`): no `console.*`. The realtime counters and spans come from `@shared/realtime`. This plan adds none to `cire/api/src/metrics.ts`, because the subscribe and publish outcomes are counted there, by product. Never log a profile id (`osnProfileId`) or a session token.
- **Changeset:** one file naming `"@cire/api": minor` and `"@cire/host": minor`. Both are version-less `@cire/*` packages, so never add a versioned package to it (AGENTS.md "Changesets"). This PR changes no versioned package. If a fix to `@shared/realtime` turns out to be needed, it goes back into phase 1, not here.
- **Installs:** never a bare `bun install`. Splice `bun.lock` by hand (exact lines in Tasks 1 and 6), prove it with `bun install --frozen-lockfile`, and check that `git diff bun.lock` shows only the spliced lines.
- **Wrangler named environments inherit no bindings.** Every binding added at the top level of `cire/api/wrangler.toml` is redeclared under `[env.dev]` and `[env.production]`. Dry runs confirmed on 2026-09-26 that:
  - top-level `[[migrations]]` **are** inherited;
  - a `durable_objects` binding missing from an env draws a warning and ships without it;
  - a bound class the entry does not export fails the dry run.
- **Free plan:** each admitted socket costs one Worker request plus one DO request, and each publish costs one DO request. Whether each client `ping` also costs a DO request is not documented (phase 1, "Free-plan fit"). Both allowances are 100,000 a day, account-wide (`wiki/shared/free-tier-limits.md`, updated in phase 1). Do not add a second DO class, an alarm, or anything that keeps a hub awake. Publish only on a real change. The Task 8 deploy walk measures DO requests per open tab-hour before production.
- **Public repository:** no tracker ID, finding tag or phase code in any comment, commit message, changeset, wiki page or PR body (`wiki/conventions/code-comments.md`, `house/no-tracker-ref-in-comment`). Comments state what the code guarantees now.
- **Lint and format:** add no oxlint warnings (CI ceiling), no stacked doc blocks, and keep `bun run fmt:check` clean.
- **Wiki:** invoke `write-wiki` before editing any page under `wiki/`.

## Review Focus

These are the input classes and failure modes the spec implies but does not spell out, most likely first. Each has a test in the task that owns it.

1. **A removed co-host whose tab stays open.** The hub sends them the signal, then evicts their socket (4001). Their reconnect is refused (403). Their tab's re-read drops the wedding. If they were offline at the moment of removal, their reconnects are all refused, and the client's `stopped` signal (phase 1) prompts the re-read. Tests: Task 5 (the remove route evicts that profile) and Task 7 (the browser drops the rows on a signal and on a dropped socket).
2. **A co-host narrowed to `helper`.** A helper's seat has no `member` capability (`cire/api/src/middleware/wedding-role.ts` `policyFor`). Its subscribe must be refused, exactly as `weddingMember()` refuses its reads. The portal must also stop listening when the re-read swaps in the helper seat. Tests: Task 3 (helper → 403) and Task 6 (the topic URL is null for a helper).
3. **A request the Elysia app would mangle.** An upgrade that reached Elysia would come back 404 or throw `RangeError` on workerd, because a plugin set a header and Elysia rebuilt the `Response`. This was seen in a Miniflare spike on 2026-09-26. The route must return the hub's own `Response` object, and refusals must not carry Elysia's CORS headers. Test: Task 4 (identity check at the Worker entry).
4. **A tier with no hub.** Examples: unit tests, or a deploy that lost the binding. The Worker's subscribe answers 503, and the co-host writes succeed exactly as before. The local Bun dev server (`src/local.ts`) never runs the Worker entry, so there `/realtime/*` reaches the Elysia app and answers 404, and the client falls back just the same. Tests: Task 3 (503), Task 4 (a deployed tier without the binding still serves) and Task 5 (writes with no hub, and with a hub that rejects).
5. **The Content-Security-Policy.** `connect-src 'self' https://api.cireweddings.com` does **not** admit a `wss://api.cireweddings.com` socket in Chromium. On 2026-09-26, Playwright's Chromium 151.0.7922.34 blocked a `wss:` socket under an `https:`-only source with a `connect-src` violation, and opened it once the `wss:` origin was listed. The `ws:`/`http:` pair behaved the same, one run per policy. So without the `wss:` source the production portal's socket is blocked, and every tier falls back silently. Tests: Task 6 (`headers.test.ts` pins `wss://` in `connect-src`, and `tier-headers` retargets it per tier). The browser tier cannot apply `_headers`, so the policy itself is proved on the Task 8 deploy walk.

## Deliberate choices, beyond the spec's wording

Each serves the spec's intent. If review rejects one, delete the named steps.

- **Route path.** The spec's path is `GET /realtime/:topic`, not under `/api`. It is kept as written, because it is not an Elysia route, and the `/api/` prefix is what cire's Elysia routes share.
- **Rate limit placement.** The rate limit runs **after** session auth and **before** the membership check. The limiter is keyed on the organiser, and the membership check is the costliest step.
- **A new native rate-limit binding.** `REALTIME_RATE_LIMITER` uses namespace `1006`, with `1106` for dev, at 30 per 60 s, and falls back to an in-memory limiter as cire's registry limiters do. An in-memory counter is per isolate. It cannot bound one organiser's spend of the account-wide Durable Object daily allowance, for the same reason `cire/api/wrangler.toml` gives for `REGISTRY_PREVIEW_RATE_LIMITER`.
- **Publish on add as well as remove and re-role.** The spec says to publish after "any other host add/remove path found during planning". The add path is `POST /hosts`. A search of `cire/api/src` found that at runtime only `hostsService.add`, `setRole` and `remove` write `wedding_hosts`. No leave, transfer, wedding-delete, account-delete, revert or import path touches it. Seeds and data migrations write it outside the runtime (Task 5). Today an add changes nothing any listener shows (Task 5 explains).
- **Publish in the background, and only on a real change.** Each publish runs in the request's `waitUntil`, so a co-host write never waits on the hub. A remove publishes only when a seat was actually deleted. The spec's "the write's response is unaffected" is read as covering latency too.
- **An off switch that survives a revert.** After the first production deploy, the `TopicHub` class and its `v1` migration can no longer simply be reverted (Task 8, "Turning push off").
- **Evict the co-host whose seat changed** (phase 1's `evictSubjects`) on remove and on re-role. Their socket reconnects and has its membership checked again, so a removed co-host stops hearing about the wedding.
- **Organiser origin only.** The origin allow list is the organiser portal alone (`WEB_ORIGIN` entry `[1]`), not all three cire origins. Only the portal listens.
- **The migration is declared once, not mirrored.** The spec says the binding **and** the migration are "mirrored into `[env.dev]` and `[env.production]`". This plan mirrors the binding and declares the migration once, at the top level. Named environments inherit top-level migrations: "If a migration is only specified at the top-level… the environment will inherit the top-level migration" (https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/). A 2026-09-26 dry-run probe with wrangler 4.127.1 warned about a binding missing from `env.production`, but said nothing about migrations. Declaring the migration in three places would mean three lists to keep identical forever.
- **`[[migrations]]`, not the newer `exports` table.** Cloudflare now calls `migrations` "legacy" and prefers a declarative `[exports.TopicHub] type = "durable-object" storage = "sqlite"` for new Workers, and the two cannot be combined (https://developers.cloudflare.com/workers/wrangler/configuration/). Both forms passed a wrangler 4.127.1 dry run. This plan keeps `new_sqlite_classes`, as the spec names, because it is the form every Cloudflare example and deploy path has supported for years, while `exports` has no documented minimum wrangler version.

## File Structure

```
cire/api/
  wrangler.toml                 main → src/entry.ts; REALTIME_HUB + migration v1 + REALTIME_RATE_LIMITER (top, dev, prod)
  package.json                  + "@shared/realtime": "workspace:*"
  src/entry.ts                  NEW — Worker module: re-exports TopicHub and the default handler
  src/index.ts                  Env gains REALTIME_HUB / REALTIME_RATE_LIMITER; builds the realtime route; dispatches it before Elysia
  src/app.ts                    AppOptions gains realtimeHub / realtimeLimiter; organiserAuthOptions() extracted; signals passed to host routes
  src/middleware/osn-auth.ts    resolveOsnProfileId() extracted from the derive
  src/routes/realtime.ts        NEW — createRealtimeRoute(db, options)
  src/services/realtime.ts      NEW — weddingTopic(), WeddingSignals, createWeddingSignals()
  src/routes/organiser-hosts.ts publish after add / role change / remove
  tests/wrangler-config.test.ts NEW
  tests/middleware/osn-auth.test.ts   + resolveOsnProfileId cases
  tests/routes/realtime.test.ts NEW
  tests/services/realtime.test.ts     NEW
  tests/index.test.ts           + realtime-at-the-entry cases
  tests/routes/organiser-hosts.test.ts + publish cases
cire/host/
  package.json                  + "@shared/realtime": "workspace:*"
  public/_headers               connect-src + wss://api.cireweddings.com
  src/lib/tier-headers.ts       retargets the wss:// origin too
  src/lib/realtime.ts           NEW — weddingTopicUrl()
  src/components/OrganiserApp.tsx  Dashboard listens on the open wedding
  vitest.config.ts              registers the realtime browser commands
  tests/test-support/browser-commands.ts  + start/push/drop/count/stop realtime server
  tests/lib/realtime.test.ts    NEW
  tests/lib/headers.test.ts, tests/lib/tier-headers.test.ts   updated
  tests/components/OrganiserApp.test.tsx    + signal cases
  tests/components/OrganiserApp.realtime.browser.test.tsx   NEW
bun.lock                        two workspace dependency splices
wiki/…, .changeset/cire-realtime-push.md   (Task 8)
```

**Evidence this plan's code runs.** On 2026-09-26, every code block and edit in Tasks 1–7 was applied, as written, on top of phase 1 in a throwaway worktree of this branch, and run there. The worktree was then removed.

| Gate | Result |
|---|---|
| `bun install --frozen-lockfile` | +2 lines over phase 1 |
| `wrangler-config.test.ts` | 8 pass |
| dry runs (top, dev, production) | all three list `env.REALTIME_HUB (TopicHub)` |
| `bun run --cwd cire/api check` | exit 0 |
| `bun run --cwd cire/api test` | 2,448 pass, against 2,398 on the branch before (+50: wrangler-config 8, osn-auth 4, realtime route 21, index 4, workerd entry 2, services/realtime 5, organiser-hosts 6) |
| `bun run --cwd cire/host test:run` | 1,491 pass, against 1,482 (+9) |
| `bun run --cwd cire/host check` | 0 errors |
| `bun run --cwd cire/host test:browser` | 7 files, 31 pass, 3.5 s, no exit hang |
| `bun run --cwd cire/host build` | CSP `connect-src 'self' http://localhost:8787 ws://localhost:8787`; `_astro` gzip total 247,266 bytes, under the 252,653 threshold |
| oxlint warnings | cire/api 175 → 175 and cire/host 94 → 94, no errors |

Each "see it fail" step was run and failed as stated:

- the entry tests fail with the dispatch reverted (3 of 3);
- the role-change publish test fails with its line deleted;
- both browser cases fail with `useTopic` removed.

The stress-plan revisions (Tasks 4 and 5, and phase 1's hub and client) were re-run the same way; the table shows those counts. The run before the attack found five defects, all now fixed in this plan:

- the publish tests hit the shared host limiter (429);
- the browser test's `vi.mock` factories used JSX, which a browser-mode factory cannot, and did not use a hoisted helper;
- it used `organiserApiMock`, which a browser-mode factory cannot load;
- its toast mock lacked the `toast` export;
- the refused-case count was off by one.

---

### Task 1: Bind the hub and give the Worker an entry module that exports it

**Files:**
- Create: `cire/api/src/entry.ts`
- Modify: `cire/api/wrangler.toml` (line 2 `main`; the new blocks go after line 195, 343 and 475 — the `REGISTRY_GUEST_RATE_LIMITER` block of each tier)
- Modify: `cire/api/src/index.ts` (the `Env` interface, lines 40–174)
- Modify: `cire/api/package.json`, `bun.lock`
- Test: `cire/api/tests/wrangler-config.test.ts`

**Interfaces:**
- Consumes: `TopicHub` from `@shared/realtime/hub` (phase 1 Task 5)
- Produces: `Env.REALTIME_HUB?: DurableObjectNamespace<TopicHub>` and `Env.REALTIME_RATE_LIMITER?: WorkersRateLimitBinding`. The Worker's module entry becomes `src/entry.ts`.

Why a separate entry: `tests/index.test.ts:8` imports `handler from "../src/index"` under `bun test`. `@shared/realtime/hub` imports `cloudflare:workers`, which Bun cannot resolve. So the hub export lives in a module no test imports. Every existing comment that says the handler is in `src/index.ts` stays true.

- [ ] **Step 1: Write the failing config guard `tests/wrangler-config.test.ts`**

```ts
import { describe, expect, it } from "bun:test";

/**
 * The realtime push bindings, per tier. Named environments inherit no
 * bindings, so each tier must declare its own; a tier that forgets ships with
 * push off and nothing fails. The class declaration is the opposite: a
 * top-level migration is inherited, and declaring it once is the rule.
 */

interface RateLimit {
  name: string;
  type: string;
  namespace_id: string;
  simple: { limit: number; period: number };
}
interface Tier {
  durable_objects?: { bindings?: { name: string; class_name: string }[] };
  unsafe?: { bindings?: RateLimit[] };
}
interface Config extends Tier {
  main: string;
  migrations?: { tag: string; new_sqlite_classes?: string[] }[];
  env: { dev: Tier & { migrations?: unknown }; production: Tier & { migrations?: unknown } };
}

const config = Bun.TOML.parse(
  await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
) as Config;

const tiers: [string, Tier, string][] = [
  ["the top level", config, "1006"],
  ["env.dev", config.env.dev, "1106"],
  ["env.production", config.env.production, "1006"],
];

describe("wrangler.toml — realtime push", () => {
  it("makes the module that exports the hub class the Worker's entry", () => {
    expect(config.main).toBe("src/entry.ts");
  });

  it("declares TopicHub once, SQLite-backed, at the top level only", () => {
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["TopicHub"] }]);
    expect(config.env.dev.migrations).toBeUndefined();
    expect(config.env.production.migrations).toBeUndefined();
  });

  it.each(tiers)("%s binds REALTIME_HUB to TopicHub", (_label, tier) => {
    expect(tier.durable_objects?.bindings).toContainEqual({
      name: "REALTIME_HUB",
      class_name: "TopicHub",
    });
  });

  it.each(tiers)("%s binds REALTIME_RATE_LIMITER on its own namespace", (_label, tier, namespace) => {
    const bindings = tier.unsafe?.bindings ?? [];
    expect(bindings.find((binding) => binding.name === "REALTIME_RATE_LIMITER")).toEqual({
      name: "REALTIME_RATE_LIMITER",
      type: "ratelimit",
      namespace_id: namespace,
      simple: { limit: 30, period: 60 },
    });
    const ids = bindings.map((binding) => binding.namespace_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

Run, from `cire/api`: `bun test tests/wrangler-config.test.ts`
Expected: FAIL — `main` is `src/index.ts`, and the bindings are absent.

- [ ] **Step 2: Add the dependency and splice `bun.lock`**

In `cire/api/package.json` `dependencies`, add `"@shared/realtime": "workspace:*",` after `"@shared/rate-limit": "workspace:*",`.

In `bun.lock`'s `"cire/api"` block (it starts at line 20), add the same line after `        "@shared/rate-limit": "workspace:*",`:

```
        "@shared/realtime": "workspace:*",
```

Run: `bun install --frozen-lockfile && git diff --stat bun.lock`
Expected: succeeds, with +1 line in `bun.lock`.

- [ ] **Step 3: Write `cire/api/src/entry.ts`**

```ts
// The Worker's module: its fetch/scheduled handler and every Durable Object
// class it hosts. Kept apart from `index.ts` because `@shared/realtime/hub`
// imports `cloudflare:workers`, which only workerd provides — Bun tests import
// the handler from `index.ts` and must never load it.
export { TopicHub } from "@shared/realtime/hub";
export { default } from "./index";
```

- [ ] **Step 4: Edit `cire/api/wrangler.toml`**

(a) Line 2: `main = "src/index.ts"` → `main = "src/entry.ts"`.

(b) After the top-level `REGISTRY_GUEST_RATE_LIMITER` block (the one ending at line 195) and before `[[d1_databases]]`, insert:

```toml
# Per-organiser limiter for the realtime subscribe route (`/realtime/:topic`,
# src/routes/realtime.ts). Every admitted upgrade spends a Durable Object
# request from the account's daily allowance, and an in-memory counter counts
# per isolate, so it cannot bound one organiser across the edge. 30/60 is far
# above a person switching weddings; a reconnect after a deploy spends one per
# open tab. Mirrors `defaultRealtimeLimiter` in src/routes/realtime.ts.
[[unsafe.bindings]]
name = "REALTIME_RATE_LIMITER"
type = "ratelimit"
namespace_id = "1006"
simple = { limit = 30, period = 60 }

# Realtime push hub: `@shared/realtime`'s `TopicHub`, exported from
# src/entry.ts, one Durable Object per wedding topic. Named environments do NOT
# inherit this binding — it is redeclared under [env.dev] and [env.production].
[[durable_objects.bindings]]
name = "REALTIME_HUB"
class_name = "TopicHub"

# The hub class and its storage backend. SQLite is the only backend on the
# Workers Free plan; the hub stores nothing, but a class must still declare
# one. Named environments inherit top-level migrations, so this is declared
# once, here. A deployed migration is never edited or removed — a change to
# the class list is a new entry with a new tag.
[[migrations]]
tag = "v1"
new_sqlite_classes = ["TopicHub"]
```

(c) After the `[[env.dev.unsafe.bindings]]` block for `REGISTRY_GUEST_RATE_LIMITER` (ending at line 343), insert:

```toml
# The realtime limiter on the dev range, for the same reason as the others.
[[env.dev.unsafe.bindings]]
name = "REALTIME_RATE_LIMITER"
type = "ratelimit"
namespace_id = "1106"
simple = { limit = 30, period = 60 }

# The dev Worker's own hub namespace — a different Worker script from
# production, so no socket or signal crosses tiers.
[[env.dev.durable_objects.bindings]]
name = "REALTIME_HUB"
class_name = "TopicHub"
```

(d) After the `[[env.production.unsafe.bindings]]` block for `REGISTRY_GUEST_RATE_LIMITER` (ending at line 475), insert:

```toml
[[env.production.unsafe.bindings]]
name = "REALTIME_RATE_LIMITER"
type = "ratelimit"
namespace_id = "1006"
simple = { limit = 30, period = 60 }

[[env.production.durable_objects.bindings]]
name = "REALTIME_HUB"
class_name = "TopicHub"
```

Namespace ids `1006` and `1106` are unused: `grep -rn namespace_id --include='*.toml' .` lists cire's 1001–1005 and 1101–1105, and osn's 2001–2005, 2101–2105 and 2201–2205.

- [ ] **Step 5: Add the two bindings to `Env` in `cire/api/src/index.ts`**

Add to the imports:

```ts
import type { TopicHub } from "@shared/realtime/hub";
```

`import type` is erased under `verbatimModuleSyntax`, so `bun test` never loads `cloudflare:workers`.

Add inside `interface Env`, after `REGISTRY_GUEST_RATE_LIMITER?: WorkersRateLimitBinding;`:

```ts
  // Realtime push hub (`@shared/realtime`): one Durable Object per wedding
  // topic. Absent ⇒ `/realtime/*` answers 503 and host changes publish
  // nothing; tabs keep their own refetch triggers. In a deployed tier its
  // absence is logged once per isolate. Deleting this binding from a tier is
  // the off switch — see `wiki/cire/cire.md`.
  REALTIME_HUB?: DurableObjectNamespace<TopicHub>;
  // Per-organiser limiter for `/realtime/*` upgrades. Absent ⇒ the per-isolate
  // in-memory default in `routes/realtime.ts`.
  REALTIME_RATE_LIMITER?: WorkersRateLimitBinding;
```

- [ ] **Step 6: Run the guard, the type-check and the three dry runs**

Run: `bun test tests/wrangler-config.test.ts`, from `cire/api`.
Expected: PASS (8 tests).

Run: `bun run --cwd cire/api check`
Expected: exit 0.

Run, from `cire/api`:

```bash
bun run build
bunx wrangler deploy --dry-run --env dev --outdir /tmp/cire-api-dev
bunx wrangler deploy --dry-run --env production --outdir /tmp/cire-api-prod
```

Expected, for all three:
- exit 0;
- the binding table lists `env.REALTIME_HUB (TopicHub)  Durable Object` and `env.REALTIME_RATE_LIMITER (ratelimit)  Unsafe Metadata`;
- no `"durable_objects" exists at the top level, but not on "env.…"` warning.

The dev and production runs also print two warnings that are already there on `main`: `"unsafe" fields are experimental`, and `ZAP_API_URL` missing from `env.dev.vars`, which is deliberate (`wrangler.toml` lines 274–277). Both appeared in the 2026-09-26 run. Record the real output in the PR's test plan.

- [ ] **Step 7: See the dry run fail**

Temporarily delete the `export { TopicHub } …` line from `src/entry.ts` and run `bun run build`.
Expected: `✘ [ERROR] Your Worker depends on the following Durable Objects, which are not exported in your entrypoint file: TopicHub.`, seen in a 2026-09-26 probe with wrangler 4.127.1. Restore the line.

- [ ] **Step 8: Commit**

```bash
git add cire/api/src/entry.ts cire/api/wrangler.toml cire/api/src/index.ts cire/api/package.json \
  cire/api/tests/wrangler-config.test.ts bun.lock
git commit -m "Bind the realtime hub in cire-api and export it from a Worker entry module"
```

---

### Task 2: One session resolver for the organiser routes and the realtime route

**Files:**
- Modify: `cire/api/src/middleware/osn-auth.ts` (whole `osnAuth` body, lines 20–87)
- Modify: `cire/api/src/app.ts` (lines 541–545 and 627–635)
- Test: `cire/api/tests/middleware/osn-auth.test.ts`

**Interfaces:**
- Produces:
  - `resolveOsnProfileId(request: Request, options: OsnAuthOptions): Promise<string | undefined>` in `middleware/osn-auth.ts`
  - `organiserAuthOptions(db: Db, options: AppOptions): OsnAuthOptions` in `app.ts`

This is a behaviour-preserving extraction. The realtime route runs before Elysia, so it cannot use the `osnAuth()` plugin. It must resolve the organiser exactly as the plugin does, and the plugin then calls the same function.

- [ ] **Step 1: Write the failing tests**

Append to `cire/api/tests/middleware/osn-auth.test.ts`. Extend its existing `osn-auth` import to `import { osnAuth, resolveOsnProfileId } from "../../src/middleware/osn-auth";`, and add at its top:

```ts
import { createDb } from "../../src/db/setup";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth, OSN_TEST_ISSUER, type OsnTestAuth } from "../test-helpers/osn-token";
```

```ts
describe("resolveOsnProfileId", () => {
  let auth: OsnTestAuth;
  let baseOptions: { jwksUrl: string; audience: string; issuer: string; _testKey: CryptoKey };

  beforeAll(async () => {
    auth = await makeOsnTestAuth();
    baseOptions = {
      jwksUrl: "http://osn.test/.well-known/jwks.json",
      audience: "osn-access",
      issuer: OSN_TEST_ISSUER,
      _testKey: auth.key,
    };
  });

  const request = (headers: Record<string, string>) =>
    new Request("https://api.example.test/realtime/x", { headers });

  it("names the organiser from the cire_org_session cookie", async () => {
    const db = createDb(":memory:");
    const token = await seedOrganiserSession(db, "usr_cookie");
    const options = { ...baseOptions, db };
    expect(await resolveOsnProfileId(request({ cookie: `cire_org_session=${token}` }), options)).toBe(
      "usr_cookie",
    );
  });

  it("names the organiser from a Bearer access token", async () => {
    const token = await auth.sign("usr_bearer");
    expect(await resolveOsnProfileId(request({ authorization: `Bearer ${token}` }), baseOptions)).toBe(
      "usr_bearer",
    );
  });

  it("falls through a stale cookie to the Bearer token", async () => {
    const db = createDb(":memory:");
    const token = await auth.sign("usr_bearer");
    const headers = { cookie: "cire_org_session=not-a-session", authorization: `Bearer ${token}` };
    expect(await resolveOsnProfileId(request(headers), { ...baseOptions, db })).toBe("usr_bearer");
  });

  it("is undefined with neither", async () => {
    expect(await resolveOsnProfileId(request({}), baseOptions)).toBeUndefined();
  });
});
```

`makeOsnTestAuth` (`tests/test-helpers/osn-token.ts`) signs `aud: "osn-access"` tokens issued by `OSN_TEST_ISSUER`, the fixture `tests/routes/organiser-hosts.test.ts` uses.

Run: `bun test tests/middleware/osn-auth.test.ts`, from `cire/api`.
Expected: FAIL — `resolveOsnProfileId` is not exported.

- [ ] **Step 2: Extract `resolveOsnProfileId` in `middleware/osn-auth.ts`**

Replace everything from `/** Derive result for requests that fail verification — the handler never runs. */` to the end of the file with:

```ts
/**
 * The OSN profile behind a request, or undefined. Two ways in, tried in order:
 *
 * 1. **The `cire_org_session` cookie** — a cire session minted by the OIDC
 *    callback, which is how every browser reaches us. Identity lives on the
 *    `musubi.social` zone, so `host.cireweddings.com` can neither run a passkey
 *    ceremony nor silently refresh an OSN access token. The session row carries
 *    the real `usr_*` profile id from the ID token's first-party
 *    `osn_profile_id` claim, so everything downstream keys on it unchanged.
 * 2. **`Authorization: Bearer` with an OSN access token** — for callers that are
 *    not this browser (a first-party OSN surface holding `aud: "osn-access"`,
 *    and the route tests, which inject the verifying key).
 *
 * `osnAuth()` derives from this; the realtime subscribe route, which runs
 * before the Elysia app, calls it directly.
 */
export async function resolveOsnProfileId(
  request: Request,
  options: OsnAuthOptions,
): Promise<string | undefined> {
  const { db, ...verify } = options;
  if (db) {
    const token = parseOrganiserSessionToken(request.headers.get("cookie"));
    if (token) {
      const session = await runCire(
        organiserSessionService.validate(token).pipe(
          Effect.provideService(DbService, db),
          Effect.catchTag("OrganiserSessionInvalid", () => Effect.succeed(null)),
        ),
      );
      if (session) return session.osnProfileId;
    }
  }
  const claims = await extractClaims(request.headers.get("authorization") ?? undefined, verify.jwksUrl, {
    testKey: verify._testKey,
    audience: verify.audience,
    issuer: verify.issuer,
  });
  return claims?.profileId;
}

/**
 * Names the organiser behind a request (see {@link resolveOsnProfileId}) as
 * `osnProfileId`, or answers 401.
 *
 * Note the response code: `@osn/client`'s `authFetch` reads a 401 as "token
 * expired" and throws the session away, so an authenticated but *forbidden*
 * caller must get 403 from the role gates downstream, never 401.
 *
 * **CSRF.** The cookie makes organiser writes CSRF-eligible.
 * `originGuard(corsOrigins)` in `app.ts` covers every state-changing method and
 * the cookie is `SameSite=Lax`; that pair is the whole defence and both have
 * to stay.
 */
export function osnAuth(options: OsnAuthOptions) {
  return (
    new Elysia({ name: "cire-osn-auth" })
      // Elysia 1.4 named plugins default hooks to "local" scope — without
      // { as: "scoped" } the derive/onBeforeHandle never run in the parent app
      // and every request silently passes unauthenticated.
      .derive({ as: "scoped" }, async ({ request }) => ({
        osnProfileId: await resolveOsnProfileId(request, options),
      }))
      .onBeforeHandle({ as: "scoped" }, ({ osnProfileId, set }) => {
        if (!osnProfileId) {
          set.status = 401;
          return { error: "unauthorised" };
        }
      })
  );
}
```

Check the type of `organiserSessionService.validate(...)`'s `osnProfileId` before writing `return session.osnProfileId;`. The old code asserted `as string | undefined`, so keep an assertion only if `tsc` needs one.

- [ ] **Step 3: Extract `organiserAuthOptions` in `app.ts`**

Add above `export function createApp` (import `OsnAuthOptions` as a type from `./middleware/osn-auth`):

```ts
/**
 * How every organiser surface authenticates — the Elysia routes and the
 * realtime subscribe route alike. The defaults are the local issuer, matching
 * osn-api's own local defaults (`osn/api/src/build-deps.ts`).
 */
export function organiserAuthOptions(db: Db, options: AppOptions): OsnAuthOptions {
  return {
    jwksUrl: options.osnJwksUrl ?? "http://localhost:4000/.well-known/jwks.json",
    issuer: options.osnIssuerUrl ?? "http://localhost:4000",
    audience: options.osnAudience ?? "osn-access",
    _testKey: options.osnTestKey,
    db,
  };
}
```

In `createApp`, delete the four destructured names `osnJwksUrl`, `osnIssuerUrl`, `osnAudience` and `osnTestKey` (lines 541–545, with the comment on 542). Replace the `const osnAuthOptions = { … }` object (lines 629–635) with:

```ts
  const osnAuthOptions = organiserAuthOptions(db, options);
```

Keep the comment above it ("`db` turns on the organiser session cookie path in `osnAuth` …").

- [ ] **Step 4: Run the whole cire/api suite — the extraction must change nothing**

Run: `bun run --cwd cire/api test`
Expected: PASS. The new cases pass and every existing route test is unchanged: `organiser-hosts`, `organiser-changes` and `registry` exercise the cookie path, and `osn-auth.test.ts` the Bearer path. Record the pass count before and after this task. It rises by exactly 4.

Run: `bun run --cwd cire/api check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add cire/api/src/middleware/osn-auth.ts cire/api/src/app.ts cire/api/tests/middleware/osn-auth.test.ts
git commit -m "Resolve the organiser in one function the realtime route can share"
```

---

### Task 3: The realtime subscribe route

**Files:**
- Create: `cire/api/src/routes/realtime.ts`
- Modify: `cire/api/src/app.ts` (`AppOptions`: add `realtimeHub`, `realtimeLimiter`; extend the `organiserOrigin` doc comment)
- Test: `cire/api/tests/routes/realtime.test.ts`

**Interfaces:**
- Consumes:
  - `subscribe`, `HubNamespace` from `@shared/realtime/server`
  - `resolveOsnProfileId`, `organiserAuthOptions` (Task 2)
  - `hostsService.authorize(weddingId, osnProfileId)` (`cire/api/src/services/hosts.ts:661`)
  - `decideCapability(role, "member")` (`cire/api/src/middleware/wedding-role.ts`)
- Produces:
  - `AppOptions.realtimeHub?: HubNamespace` and `AppOptions.realtimeLimiter?: RateLimiterBackend`
  - `type RealtimeRoute = (request: Request) => Promise<Response> | undefined`
  - `createRealtimeRoute(db: Db, options?: AppOptions): RealtimeRoute`. It returns `undefined` for any path not shaped `/realtime/<one segment>`, so the caller falls through to Elysia.
  - `WEDDING_TOPIC_ID = /^wed_[a-z0-9_]{1,60}$/`. Wedding ids are `wed_<32 hex>` (`cire/api/src/services/weddings.ts:61`), plus `wed_bootstrap` and the test ids (`wed_1`, `wed_hosts`, …).

The membership rule is `weddingMember()`'s, made from the same two calls (`cire/api/src/middleware/wedding-member.ts:95-104`). `hostsService.authorize` returns `null` for an unknown wedding, or a `role` of null for a stranger. Otherwise `decideCapability(role, "member")` decides: owner, editor and viewer are admitted, a helper is refused. The route answers 403 for an unknown wedding as well as for a refused member, because the socket must not be a way to learn which wedding ids exist.

- [ ] **Step 1: Write the failing test `tests/routes/realtime.test.ts`**

```ts
import { beforeAll, describe, expect, it } from "bun:test";

import { weddingHosts, weddings } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import type { HubNamespace } from "@shared/realtime/server";

import type { AppOptions } from "../../src/app";
import type { Db } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { createRealtimeRoute } from "../../src/routes/realtime";
import type { AssignableHostRole } from "../../src/services/hosts";
import { counterValue } from "../test-helpers/metrics-harness";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth, type OsnTestAuth } from "../test-helpers/osn-token";

const WEDDING_ID = "wed_live";
const OWNER = "usr_owner";
const PORTAL = "https://host.example.test";
const topicPath = (topic: string) => `/realtime/${encodeURIComponent(topic)}`;
const PATH = topicPath(`cire:wedding:${WEDDING_ID}`);

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/** A hub binding that records each upgrade and answers with one fixed 101. */
function fakeHub() {
  const upgrades: { name: string; subject: string | null }[] = [];
  const response = new Response(null, { status: 101 });
  const hub: HubNamespace = {
    getByName: (name) => ({
      fetch: async (request) => {
        upgrades.push({ name, subject: request.headers.get("x-realtime-subject") });
        return response;
      },
      publish: async () => 0,
    }),
  };
  return { hub, upgrades, response };
}

function setup(overrides: Partial<AppOptions> = {}) {
  const db = createDb(":memory:");
  const now = new Date();
  db.insert(weddings)
    .values({
      id: WEDDING_ID,
      slug: "live",
      displayName: "Live",
      ownerOsnProfileId: OWNER,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const hub = fakeHub();
  const route = createRealtimeRoute(db, {
    osnTestKey: auth.key,
    organiserOrigin: PORTAL,
    realtimeHub: hub.hub,
    ...overrides,
  });
  return { db, route, hub };
}

function seat(db: Db, osnProfileId: string, role: AssignableHostRole) {
  db.insert(weddingHosts)
    .values({
      id: `whost_${osnProfileId}`,
      weddingId: WEDDING_ID,
      osnProfileId,
      addedByOsnProfileId: OWNER,
      role,
      createdAt: new Date(),
    })
    .run();
}

async function upgrade(
  route: ReturnType<typeof setup>["route"],
  headers: Record<string, string>,
  path = PATH,
) {
  const res = await route(
    new Request(`https://api.example.test${path}`, {
      headers: { upgrade: "websocket", origin: PORTAL, ...headers },
    }),
  );
  if (!res) throw new Error("the route declined a realtime path");
  return res;
}

const bearer = async (profileId: string) => ({
  authorization: `Bearer ${await auth.sign(profileId)}`,
});

const accepted = () =>
  counterValue("realtime.subscribe.attempts", { product: "cire", outcome: "accepted" });

describe("createRealtimeRoute — which requests it takes", () => {
  it.each(["/api/organiser/weddings", "/realtime", "/realtime/", "/realtime/a/b", "/realtimex/a"])(
    "leaves %s to the app",
    (path) => {
      const { route } = setup();
      expect(route(new Request(`https://api.example.test${path}`))).toBeUndefined();
    },
  );
});

describe("createRealtimeRoute — admitted", () => {
  it("hands the owner's upgrade to the wedding's hub and returns its response untouched", async () => {
    const { route, hub } = setup();
    const before = await accepted();
    const res = await upgrade(route, await bearer(OWNER));
    expect(res).toBe(hub.response);
    expect(hub.upgrades).toEqual([{ name: `cire:wedding:${WEDDING_ID}`, subject: OWNER }]);
    expect(await accepted()).toBe(before + 1);
  });

  it("admits an organiser signed in by the session cookie, as the portal is", async () => {
    const { db, route, hub } = setup();
    const token = await seedOrganiserSession(db, OWNER);
    const res = await upgrade(route, { cookie: `cire_org_session=${token}` });
    expect(res).toBe(hub.response);
  });

  it.each(["editor", "viewer"] as const)("admits a co-host seated as %s", async (role) => {
    const { db, route, hub } = setup();
    seat(db, "usr_cohost", role);
    expect(await upgrade(route, await bearer("usr_cohost"))).toBe(hub.response);
  });
});

describe("createRealtimeRoute — refused", () => {
  it("refuses a helper, whose seat carries no dashboard reads", async () => {
    const { db, route, hub } = setup();
    seat(db, "usr_helper", "helper");
    expect((await upgrade(route, await bearer("usr_helper"))).status).toBe(403);
    expect(hub.upgrades).toEqual([]);
  });

  it("refuses a stranger, and an unknown wedding, with the same 403", async () => {
    const { route } = setup();
    expect((await upgrade(route, await bearer("usr_stranger"))).status).toBe(403);
    const unknown = await upgrade(route, await bearer(OWNER), topicPath("cire:wedding:wed_nope"));
    expect(unknown.status).toBe(403);
  });

  it("401s a request with no session and no token", async () => {
    const { route } = setup();
    expect((await upgrade(route, {})).status).toBe(401);
  });

  it.each([
    ["the guest site", { origin: "https://invite.example.test" }],
    ["no Origin at all", { origin: "" }],
  ])("refuses an upgrade from %s", async (_label, headers) => {
    const { route } = setup();
    const res = await upgrade(route, { ...(await bearer(OWNER)), ...headers });
    expect(res.status).toBe(403);
  });

  it("refuses every origin when no organiser origin is configured", async () => {
    const { route } = setup({ organiserOrigin: undefined });
    expect((await upgrade(route, await bearer(OWNER))).status).toBe(403);
  });

  it.each([
    ["another product's topic", "osn:org:org_1"],
    ["an entity cire does not publish", "cire:vendor:ven_1"],
    ["an id that is not a wedding id", "cire:wedding:WED_1"],
  ])("404s %s", async (_label, topic) => {
    const { route } = setup();
    expect((await upgrade(route, await bearer(OWNER), topicPath(topic))).status).toBe(404);
  });

  it("426s a request that is not an upgrade", async () => {
    const { route } = setup();
    expect((await upgrade(route, { ...(await bearer(OWNER)), upgrade: "" })).status).toBe(426);
  });

  it("429s past the per-organiser limit, and keys it per organiser", async () => {
    const { db, route } = setup({
      realtimeLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    seat(db, "usr_cohost", "editor");
    expect((await upgrade(route, await bearer(OWNER))).status).toBe(101);
    const limited = await upgrade(route, await bearer(OWNER));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await upgrade(route, await bearer("usr_cohost"))).status).toBe(101);
  });

  it("503s when no hub is bound", async () => {
    const { route } = setup({ realtimeHub: undefined });
    expect((await upgrade(route, await bearer(OWNER))).status).toBe(503);
  });
});
```

Run: `bun test tests/routes/realtime.test.ts`, from `cire/api`.
Expected: FAIL — `../../src/routes/realtime` does not resolve.

- [ ] **Step 2: Add the options to `AppOptions` in `app.ts`**

Next to the other limiter overrides, add:

```ts
  /**
   * The realtime hub binding (`REALTIME_HUB`). Absent ⇒ host changes publish
   * nothing, and the Worker's `/realtime/*` answers 503. Most tests run that
   * way; tests of push inject a stand-in. The local Bun dev server
   * (`src/local.ts`) builds this app without the Worker entry, so there
   * `/realtime/*` never reaches the realtime route and answers 404.
   */
  realtimeHub?: HubNamespace;
  /** Override the realtime subscribe per-organiser limiter (useful for testing). */
  realtimeLimiter?: RateLimiterBackend;
```

with `import type { HubNamespace } from "@shared/realtime/server";`.

Rewrite the `organiserOrigin` doc comment (lines 271–275) so its two readers are both stated:

```ts
  /**
   * Organiser portal origin (`host.cireweddings.com`). Two readers, two
   * defaults: `createApp` builds enquiry deep-links on it and falls back to
   * the production portal when it is unset; the realtime subscribe route
   * (`routes/realtime.ts`) admits it as the only `Origin` and, unset, admits
   * none — a tier that names no portal (the top-level `wrangler.toml` block,
   * local `wrangler dev`) must not accept sockets on production's behalf.
   */
```

- [ ] **Step 3: Write `src/routes/realtime.ts`**

```ts
import { createRateLimiter } from "@shared/rate-limit";
import { subscribe } from "@shared/realtime/server";
import { Effect } from "effect";

import { organiserAuthOptions, type AppOptions } from "../app";
import { DbService } from "../db";
import type { Db } from "../db";
import { resolveOsnProfileId } from "../middleware/osn-auth";
import { decideCapability } from "../middleware/wedding-role";
import { runCire } from "../observability";
import { hostsService } from "../services/hosts";

/** `/realtime/<topic>`, the topic one percent-encoded path segment. */
const REALTIME_PATH = /^\/realtime\/([^/]+)$/;

/** The ids cire mints (`wed_<hex>`), the reserved bootstrap id, and test ids. */
export const WEDDING_TOPIC_ID = /^wed_[a-z0-9_]{1,60}$/;

/**
 * Per-organiser default when no `REALTIME_RATE_LIMITER` binding is present:
 * 30 upgrades a minute, far above a person switching weddings. Counts per
 * isolate, which is why deployed tiers bind the native limiter instead.
 */
const defaultRealtimeLimiter = createRateLimiter({ maxRequests: 30, windowMs: 60_000 });

export type RealtimeRoute = (request: Request) => Promise<Response> | undefined;

/**
 * May `osnProfileId` read `weddingId`'s dashboard? The rule `weddingMember()`
 * applies to every dashboard read, from the same two calls: owner, editor and
 * viewer yes; a helper, a stranger or an unknown wedding no.
 */
const canReadWedding = (weddingId: string, osnProfileId: string) =>
  hostsService
    .authorize(weddingId, osnProfileId)
    .pipe(Effect.map((result) => (result?.role ? decideCapability(result.role, "member").allowed : false)));

/**
 * `GET /realtime/:topic` — a WebSocket onto one wedding's hub. It runs in the
 * Worker entry BEFORE the Elysia app and returns the hub's 101 response as the
 * very object the hub produced: Elysia rebuilds a returned Response whenever a
 * plugin (CORS) has set a header, and a rebuilt 101 loses its socket.
 *
 * Returns `undefined` for any other path, so the caller hands the request to
 * the app. Admits only the organiser portal's origin, an organiser signed in
 * the same way as every organiser route, within the per-organiser limit, who
 * may read the wedding's dashboard.
 */
export function createRealtimeRoute(db: Db, options: AppOptions = {}): RealtimeRoute {
  const auth = organiserAuthOptions(db, options);
  const limiter = options.realtimeLimiter ?? defaultRealtimeLimiter;
  const allowedOrigins = options.organiserOrigin ? [options.organiserOrigin] : [];
  const hub = options.realtimeHub;

  return (request) => {
    const segment = REALTIME_PATH.exec(new URL(request.url).pathname)?.[1];
    if (segment === undefined) return undefined;
    return runCire(
      subscribe(request, segment, {
        product: "cire",
        hub,
        allowedOrigins,
        acceptsTopic: (topic) => topic.entity === "wedding" && WEDDING_TOPIC_ID.test(topic.id),
        authenticate: async (req) => (await resolveOsnProfileId(req, auth)) ?? null,
        allow: async (subject) => limiter.check(subject),
        authorize: (subject, topic) =>
          runCire(canReadWedding(topic.id, subject).pipe(Effect.provideService(DbService, db))),
      }),
    );
  };
}
```

`routes/realtime.ts` imports a value from `app.ts` (`organiserAuthOptions`), but `app.ts` never imports `routes/realtime.ts`, so there is no cycle. `index.ts` imports both. If `tsc` or a lint rule reports a cycle anyway, move `organiserAuthOptions` into `middleware/osn-auth.ts` and import it from there in both files.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test tests/routes/realtime.test.ts`, from `cire/api`.
Expected: PASS — 21 tests: 5 path cases, 4 admitted, 12 refused.

Run: `bun run --cwd cire/api check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add cire/api/src/routes/realtime.ts cire/api/src/app.ts cire/api/tests/routes/realtime.test.ts
git commit -m "Add the realtime subscribe route for a wedding's hosts"
```

---

### Task 4: Answer `/realtime/*` in the Worker, before Elysia

**Files:**
- Modify: `cire/api/src/index.ts` (the `cached` declaration at line 182; the app build at lines 440–502; the dispatch at lines 515–516)
- Test: `cire/api/tests/index.test.ts`
- Test: `cire/api/tests/workerd/entry.test.ts` (new): the bundled Worker module, evaluated on workerd

**Interfaces:**
- Consumes: `createRealtimeRoute`, `RealtimeRoute` (Task 3); `Env.REALTIME_HUB`, `Env.REALTIME_RATE_LIMITER` (Task 1)
- Produces: the Worker hands `GET /realtime/:topic` to the realtime route inside the request's D1 session, and never to Elysia.

- [ ] **Step 1: Write the failing tests** — append to `cire/api/tests/index.test.ts`

Add `DB_REALTIME: "cire-test-index-realtime"` to the `d1Databases` of the file's `new Miniflare({ … })` call. In `beforeAll`, after the existing `DB.exec(ddl)`:

```ts
  DB_REALTIME = await mf.getD1Database("DB_REALTIME");
  await DB_REALTIME.exec(ddl);
```

Declare it at the top with `let DB_REALTIME: D1Database;`. It is a second database because the Worker caches its app per isolate, keyed on the identity of `env.DB` (`src/index.ts` line 271). A fresh binding is what makes the handler rebuild with `REALTIME_HUB` present.

Then add these imports and cases:

```ts
import { weddings } from "@cire/db";

import { createD1Db } from "../src/db/index";
import { seedOrganiserSession } from "./test-helpers/organiser-session";
```

```ts
describe("realtime subscribe at the Worker entry", () => {
  const PORTAL = "https://host.example.com";
  const TOPIC_PATH = `/realtime/${encodeURIComponent("cire:wedding:wed_rt")}`;

  /**
   * A new object over the same database. The Worker caches its app keyed on
   * the identity of `env.DB`, so a fresh binding makes it rebuild with this
   * test's env — the same trick as `probeD1` above. Methods are bound to the
   * real binding, as `probeD1` does, so nothing reaches Miniflare's internals
   * through the proxy.
   */
  const freshBinding = (): D1Database =>
    new Proxy(DB_REALTIME, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  async function seedOwner(): Promise<string> {
    const db = createD1Db(DB_REALTIME);
    const now = new Date();
    await db
      .insert(weddings)
      .values({
        id: "wed_rt",
        slug: "rt",
        displayName: "RT",
        ownerOsnProfileId: "usr_rt_owner",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    return seedOrganiserSession(db, "usr_rt_owner");
  }

  function envWith(hubResponse?: Response) {
    const hub = hubResponse
      ? {
          getByName: () => ({
            fetch: async () => hubResponse,
            publish: async () => 0,
          }),
        }
      : undefined;
    return {
      ...BASE_ENV,
      DB: freshBinding(),
      WEB_ORIGIN: `https://invite.example.com,${PORTAL}`,
      ...(hub ? { REALTIME_HUB: hub } : {}),
    } as unknown as Parameters<NonNullable<typeof handler.fetch>>[1];
  }

  it("hands an admitted upgrade the hub's own response, not one Elysia rebuilt", async () => {
    const token = await seedOwner();
    const hubResponse = new Response(null, { status: 101 });
    const res = await handler.fetch!(
      new Request(`https://api.example.com${TOPIC_PATH}`, {
        headers: { upgrade: "websocket", origin: PORTAL, cookie: `cire_org_session=${token}` },
      }) as Parameters<NonNullable<typeof handler.fetch>>[0],
      envWith(hubResponse),
      ctx,
    );
    expect(res).toBe(hubResponse);
  });

  it("refuses by itself, before Elysia: no 404, and no CORS headers even for the portal", async () => {
    // The portal's own origin with no session: Elysia's CORS plugin would echo
    // this origin on any response it built, so a missing header proves the
    // refusal never went through the app.
    const res = await handler.fetch!(
      new Request(`https://api.example.com${TOPIC_PATH}`, {
        headers: { upgrade: "websocket", origin: PORTAL },
      }) as Parameters<NonNullable<typeof handler.fetch>>[0],
      envWith(new Response(null, { status: 101 })),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await res.text()).toBe("");
  });

  it("limits with the REALTIME_RATE_LIMITER binding when one is bound", async () => {
    const token = await seedOwner();
    const env = {
      ...(envWith(new Response(null, { status: 101 })) as unknown as Record<string, unknown>),
      REALTIME_RATE_LIMITER: { limit: async () => ({ success: false }) },
    } as unknown as Parameters<NonNullable<typeof handler.fetch>>[1];
    const res = await handler.fetch!(
      new Request(`https://api.example.com${TOPIC_PATH}`, {
        headers: { upgrade: "websocket", origin: PORTAL, cookie: `cire_org_session=${token}` },
      }) as Parameters<NonNullable<typeof handler.fetch>>[0],
      env,
      ctx,
    );
    expect(res.status).toBe(429);
  });

  it("serves a deployed tier without the hub binding, answering 503 for realtime only", async () => {
    const env = envWith();
    const token = await seedOwner();
    const realtime = await handler.fetch!(
      new Request(`https://api.example.com${TOPIC_PATH}`, {
        headers: { upgrade: "websocket", origin: PORTAL, cookie: `cire_org_session=${token}` },
      }) as Parameters<NonNullable<typeof handler.fetch>>[0],
      env,
      ctx,
    );
    expect(realtime.status).toBe(503);
    const list = await handler.fetch!(
      new Request("https://api.example.com/api/organiser/weddings", {
        headers: { cookie: `cire_org_session=${token}` },
      }) as Parameters<NonNullable<typeof handler.fetch>>[0],
      env,
      ctx,
    );
    expect(list.status).toBe(200);
  });
});
```

Every `envWith()` call hands the handler a fresh binding. So each case builds its own app with its own hub, or none, whatever order the cases run in. Within one case, requests that share an `env` share one app.

The refusal case uses the portal's own origin with no session. Elysia's CORS plugin echoes an allowed origin on any response it builds, so a missing `access-control-allow-origin` proves the 401 never went through the app. A foreign origin would prove nothing, because Elysia would not echo that either. The limiter case is the only proof that `REALTIME_RATE_LIMITER` is wired: delete the `createWorkersRateLimiter(env.REALTIME_RATE_LIMITER)` line and it fails.

Run: `bun test tests/index.test.ts`, from `cire/api`.
Expected: FAIL — the first case gets a non-identical response, a 404 from Elysia.

- [ ] **Step 2: Wire the route into `src/index.ts`**

(a) Import: `import { createRealtimeRoute, type RealtimeRoute } from "./routes/realtime";`

(b) Line 182:

```ts
let cached:
  | { app: ReturnType<typeof createApp>; realtime: RealtimeRoute; dbBinding: D1Database }
  | undefined;
```

(c) After `if (registryGuestEdgeLimiter) appOptions.registryGuestLimiter = registryGuestEdgeLimiter;` (line 497), insert:

```ts
      // Realtime push rides the same options as the app, so its subscribe
      // route authenticates exactly as the organiser routes do. No hub bound ⇒
      // push is off: the route answers 503, host changes publish nothing, and
      // tabs keep their own refetch triggers — loud in a deployed tier.
      if (env.REALTIME_HUB) appOptions.realtimeHub = env.REALTIME_HUB;
      if (env.REALTIME_RATE_LIMITER) {
        appOptions.realtimeLimiter = createWorkersRateLimiter(env.REALTIME_RATE_LIMITER);
      }
      if (!env.REALTIME_HUB && isDeployedTier(env)) {
        await runCire(
          Effect.logError("REALTIME_HUB binding missing in a deployed tier", {
            detail: "push is off: /realtime answers 503 and host changes reach open tabs on their next refetch",
          }),
        );
      }
```

(d) Replace the `cached = { … }` assignment (lines 498–501) with:

```ts
      cached = {
        dbBinding: env.DB,
        app: createApp(db, appOptions),
        realtime: createRealtimeRoute(db, appOptions),
      };
```

(e) Replace lines 515–516:

```ts
    const { app, realtime } = cached;
    // `/realtime/*` is answered before Elysia and inside the same D1 session:
    // the hub's 101 must reach the runtime as the very object the hub returned,
    // and Elysia rebuilds any Response once a plugin has set a header.
    const response = await runInD1Session(env.DB, () => realtime(request) ?? app.fetch(request));
```

- [ ] **Step 3: Run the tests and watch them pass**

Run: `bun test tests/index.test.ts`, from `cire/api`.
Expected: PASS, including the four new cases.

Run: `bun run --cwd cire/api build`
Expected: exit 0, with `REALTIME_HUB` in the binding table.

- [ ] **Step 4: Boot the Worker module on workerd — `tests/workerd/entry.test.ts`**

Every other cire-api test runs the handler under Bun, and a dry run does not evaluate the module. Without this test, the first time `src/entry.ts` runs on workerd would be the dev deploy (the `debug-workers` skill, §"module-evaluation crash"). It boots **wrangler's own bundle**, the artefact a deploy uploads. `Bun.build` output does not work here: it injects `createRequire(import.meta.url)`, which workerd refuses at startup. That was seen on 2026-09-26. `.wrangler/` is gitignored (`.gitignore` line 188). The file sits outside `tests/db/`, so the ordinary `bun run --cwd cire/api test` runs it, in about 2 s.

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Miniflare } from "miniflare";

/**
 * The Worker module (`src/entry.ts`) evaluated on real workerd, with the hub
 * bound as wrangler binds it. Every other cire-api test runs the handler under
 * Bun, which never evaluates the module the way a deploy does, and a dry run
 * does not evaluate it at all — so without this the first evaluation would be
 * the dev deploy. The hub runs in the same script, so its isolate evaluates
 * the whole graph too.
 */

const HOOK_TIMEOUT_MS = 60_000;
let mf: Miniflare;

beforeAll(async () => {
  // Wrangler's own bundle, the artefact a deploy uploads: the same dry run as
  // `bun run build`, written to a directory of this test's own.
  const outdir = `${import.meta.dirname}/../../.wrangler/entry-test`;
  const build = Bun.spawnSync(
    ["bunx", "wrangler", "deploy", "--dry-run", "--env", "dev", "--outdir", outdir],
    { cwd: `${import.meta.dirname}/../..`, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(`wrangler build failed: ${build.stderr.toString()}`);
  mf = new Miniflare({
    modules: true,
    scriptPath: `${outdir}/entry.js`,
    // `cire/api/wrangler.toml` lines 3 and 18.
    compatibilityDate: "2025-03-01",
    compatibilityFlags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
    d1Databases: { DB: "cire-test-entry" },
    durableObjects: { REALTIME_HUB: { className: "TopicHub", useSQLite: true } },
    bindings: {
      OSN_ENV: "local",
      WEB_ORIGIN: "https://invite.example.test,https://host.example.test",
      OSN_JWKS_URL: "https://id.example.test/.well-known/jwks.json",
      OSN_ISSUER_URL: "https://id.example.test",
      OSN_AUDIENCE: "osn-access",
    },
  });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await mf?.dispose();
});

describe("src/entry.ts on workerd", () => {
  it("evaluates, and answers /realtime before the app", async () => {
    const res = await mf.dispatchFetch(
      `https://api.example.test/realtime/${encodeURIComponent("cire:wedding:wed_1")}`,
      { headers: { Upgrade: "websocket", Origin: "https://host.example.test" } },
    );
    // No session: the realtime route's own 401, with no body. The Elysia app
    // would have answered 404 with a JSON body.
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  it("runs the hub class it exports, with the whole module evaluated in its isolate", async () => {
    const hub = await mf.getDurableObjectNamespace("REALTIME_HUB");
    const stub = hub.get(hub.idFromName("cire:wedding:wed_1")) as unknown as {
      publish(signal: unknown, evict: readonly string[]): Promise<number>;
    };
    expect(
      await stub.publish({ topic: "cire:wedding:wed_1", kind: "members-changed", at: 1 }, []),
    ).toBe(0);
  });
});
```

Run: `bun test --preload ./tests/test-helpers/metrics-harness.ts tests/workerd/entry.test.ts`, from `cire/api`.
Expected: PASS (2 tests).

See it fail twice, restoring the file after each:
- Remove the `TopicHub` line from `src/entry.ts`: the wrangler build fails.
- Add `if (globalThis.navigator?.userAgent === "Cloudflare-Workers") throw new Error("boom")` at the top of `src/index.ts`: workerd reports "Uncaught Error: boom" and both tests fail.

Both were seen failing on 2026-09-26. The same day, the three dispatch tests and the limiter test in `index.test.ts` failed with `realtime(request) ??` removed, and the limiter test failed alone with the binding line removed.

- [ ] **Step 5: Run the suite and commit**

Run: `bun run --cwd cire/api test`, then `bun run --cwd cire/api check`
Expected: all pass, and exit 0.

```bash
git add cire/api/src/index.ts cire/api/tests/index.test.ts cire/api/tests/workerd/entry.test.ts
git commit -m "Answer /realtime/* in the Worker before the Elysia app, and boot it on workerd"
```

---

### Task 5: Publish after every co-host write

**Files:**
- Create: `cire/api/src/services/realtime.ts`
- Modify: `cire/api/src/services/hosts.ts` (`remove`, lines 612–639: answer whether a seat was removed)
- Modify: `cire/api/src/routes/organiser-hosts.ts` (factory signature at line 165; the add at 222–230; the role change at 315–320; the remove at 363–388)
- Modify: `cire/api/src/app.ts` (build the signals; pass them at line 781)
- Test: `cire/api/tests/services/realtime.test.ts`, `cire/api/tests/services/hosts.test.ts`, `cire/api/tests/routes/organiser-hosts.test.ts`

**Interfaces:**
- Consumes: `publish`, `HubNamespace` (phase 1); `AppOptions.realtimeHub` (Task 3)
- Produces:
  - `weddingTopic(weddingId: string): string`, which returns `` `cire:wedding:${weddingId}` ``
  - `interface WeddingSignals { membersChanged(weddingId: string, affectedOsnProfileId: string | undefined, request: Request): Effect.Effect<void> }` — it never fails. When the Worker registered an execution context for `request` (`setExecutionCtx`, `src/lib/execution-ctx.ts`), the publish runs in `waitUntil` after the response. Otherwise (unit tests, the local server) it runs inline.
  - `hostsService.remove(...)` now returns `Effect<boolean, HostWriteError, DbService>`: whether a seat was removed, read from the same `DELETE … RETURNING` statement
  - `createWeddingSignals(hub: HubNamespace | undefined): WeddingSignals`
  - `createOrganiserHostsWriteRoutes(db, osnAuthOptions, limiter, resolveOsnProfileByHandle?, signals = createWeddingSignals(undefined))`

These are the writes that change who hosts a wedding. They are all of the **runtime** ones: at runtime, `wedding_hosts` is written only by `hostsService.add` (`services/hosts.ts:473`), `setRole` (`:578`) and `remove` (`:628`). Their routes are `POST /hosts`, `PUT /hosts/:osnProfileId/role` and `DELETE /hosts/:osnProfileId` in `routes/organiser-hosts.ts`. The owner is never rowed into `wedding_hosts`, and no path deletes a wedding. The cascade from `weddings` (`cire/db/src/schema.ts:141`) is dormant, and `internal-revoke.ts` revokes sessions, not seats. Each write is one D1 statement committed by its own `.run()`/`.all()`, so publishing after the service call returns is publishing after the commit.

Outside the runtime, rows change with no signal: the nightly dev rebuild (`cire/db/seed/dev-reset.sql`, `dev-seed.sql`, run by `.github/workflows/cire-dev-db-rebuild.yml`) and data migrations. Open tabs catch those up on their next refetch, which Task 8 records in the wiki.

The spec asks for a publish after an add as well. Today the portal only re-reads the wedding list, which an add does not change for anyone already on the dashboard, so the add's signal has no visible effect until a view such as the co-host panel listens (Open question 2). It is kept because the spec asks for it, and an add costs one Durable Object request.

- [ ] **Step 1: Write the failing service test `tests/services/realtime.test.ts`**

```ts
import { describe, expect, it } from "bun:test";

import type { HubNamespace } from "@shared/realtime/server";
import { Effect } from "effect";

import { setExecutionCtx } from "../../src/lib/execution-ctx";
import { createWeddingSignals, weddingTopic } from "../../src/services/realtime";

function recordingHub(answer: () => Promise<number> = async () => 1) {
  const calls: { name: string; kind: string; evict: readonly string[] }[] = [];
  const hub: HubNamespace = {
    getByName: (name) => ({
      publish: async (signal, evict) => {
        calls.push({ name, kind: signal.kind, evict });
        return answer();
      },
      fetch: async () => new Response(null, { status: 426 }),
    }),
  };
  return { hub, calls };
}

const request = () => new Request("https://api.example.test/api/organiser/weddings/wed_1/hosts");

describe("wedding signals", () => {
  it("names a wedding's topic", () => {
    expect(weddingTopic("wed_1")).toBe("cire:wedding:wed_1");
  });

  it("publishes members-changed on the wedding's topic, evicting nobody by default", async () => {
    const { hub, calls } = recordingHub();
    await Effect.runPromise(createWeddingSignals(hub).membersChanged("wed_1", undefined, request()));
    expect(calls).toEqual([{ name: "cire:wedding:wed_1", kind: "members-changed", evict: [] }]);
  });

  it("evicts the co-host whose seat changed", async () => {
    const { hub, calls } = recordingHub();
    await Effect.runPromise(createWeddingSignals(hub).membersChanged("wed_1", "usr_bob", request()));
    expect(calls[0]?.evict).toEqual(["usr_bob"]);
  });

  it("does nothing, and never fails, with no hub", async () => {
    await expect(
      Effect.runPromise(createWeddingSignals(undefined).membersChanged("wed_1", undefined, request())),
    ).resolves.toBeUndefined();
  });

  it("hands the publish to waitUntil, so the write does not wait on a hung hub", async () => {
    const { hub, calls } = recordingHub(() => new Promise(() => {}));
    const scheduled: Promise<unknown>[] = [];
    const req = request();
    setExecutionCtx(req, { waitUntil: (promise) => scheduled.push(promise) });

    const started = Date.now();
    await Effect.runPromise(createWeddingSignals(hub).membersChanged("wed_1", undefined, req));

    expect(Date.now() - started).toBeLessThan(500);
    expect(scheduled).toHaveLength(1);
    // The publish is under way in the background, not skipped.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
  });
});
```

Run: `bun test tests/services/realtime.test.ts`, from `cire/api`.
Expected: FAIL — the module does not resolve.

- [ ] **Step 2: Write `src/services/realtime.ts`**

```ts
import { publish, type HubNamespace } from "@shared/realtime/server";
import { Effect } from "effect";

import { getWaitUntil } from "../lib/execution-ctx";
import { runCire } from "../observability";

/** The topic every open tab showing one wedding listens on. */
export const weddingTopic = (weddingId: string): string => `cire:wedding:${weddingId}`;

export interface WeddingSignals {
  /**
   * The wedding's hosts changed. Call after the write has committed.
   * `affectedOsnProfileId` is the co-host whose seat changed: their sockets
   * are closed after the signal, so they reconnect and have their access
   * checked again. `request` is the write's own request: when the Worker
   * registered an execution context for it, the publish runs after the
   * response in `waitUntil`, so the write never waits on the hub. Never fails.
   */
  membersChanged(
    weddingId: string,
    affectedOsnProfileId: string | undefined,
    request: Request,
  ): Effect.Effect<void>;
}

export const createWeddingSignals = (hub: HubNamespace | undefined): WeddingSignals => ({
  membersChanged: (weddingId, affectedOsnProfileId, request) => {
    const work = publish(
      hub,
      weddingTopic(weddingId),
      "members-changed",
      affectedOsnProfileId === undefined ? {} : { evictSubjects: [affectedOsnProfileId] },
    );
    const waitUntil = getWaitUntil(request);
    // No execution context (unit tests, the local Bun server): run inline.
    return waitUntil ? Effect.sync(() => waitUntil(runCire(work))) : work;
  },
});
```

Run: `bun test --preload ./tests/test-helpers/metrics-harness.ts tests/services/realtime.test.ts`
Expected: PASS (5 tests). The `waitUntil` case fails, taking the full 2 s timeout, if the service always runs inline. That was seen on 2026-09-26.

- [ ] **Step 3: Write the failing route tests** — append to `tests/routes/organiser-hosts.test.ts`

Add the import `import type { HubNamespace } from "@shared/realtime/server";`, then:

```ts
describe("co-host writes publish members-changed", () => {
  function recordingHub(rejects = false) {
    const publishes: { name: string; evict: readonly string[] }[] = [];
    const hub: HubNamespace = {
      getByName: (name) => ({
        publish: async (_signal, evict) => {
          publishes.push({ name, evict });
          if (rejects) throw new Error("hub down");
          return 1;
        },
        fetch: async () => new Response(null, { status: 426 }),
      }),
    };
    return { hub, publishes };
  }

  function seedCohost(db: Db, role: AssignableHostRole = "editor") {
    seedHostSeat(db, COHOST, role);
  }

  // Its own limiter: the file's earlier cases spend the owner's share of the
  // module-level default (`defaultHostLimiter` in src/app.ts, 20 a minute per
  // organiser), and without this every case here answers 429.
  const buildPublishingApp = (hub: HubNamespace) =>
    buildApp({
      realtimeHub: hub,
      hostLimiter: createRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
    });

  const topic = `cire:wedding:${WEDDING_ID}`;

  it("after an add, evicting nobody", async () => {
    const { hub, publishes } = recordingHub();
    const { app } = buildPublishingApp(hub);
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "bob" });
    expect(res.status).toBe(201);
    expect(publishes).toEqual([{ name: topic, evict: [] }]);
  });

  it("after a role change, evicting the re-roled co-host", async () => {
    const { hub, publishes } = recordingHub();
    const { db, app } = buildPublishingApp(hub);
    seedCohost(db);
    const res = await req(app, "PUT", `${hostsPath}/${COHOST}/role`, OWNER, { role: "helper" });
    expect(res.status).toBe(200);
    expect(publishes).toEqual([{ name: topic, evict: [COHOST] }]);
  });

  it("after a removal, evicting the removed co-host", async () => {
    const { hub, publishes } = recordingHub();
    const { db, app } = buildPublishingApp(hub);
    seedCohost(db);
    const res = await req(app, "DELETE", `${hostsPath}/${COHOST}`, OWNER);
    expect(res.status).toBe(200);
    expect(publishes).toEqual([{ name: topic, evict: [COHOST] }]);
  });

  it("never for a refused write", async () => {
    const { hub, publishes } = recordingHub();
    const { db, app } = buildPublishingApp(hub);
    seedCohost(db);
    expect((await req(app, "POST", hostsPath, OWNER, { handle: "bob" })).status).toBe(409);
    expect((await req(app, "POST", hostsPath, OWNER, { handle: "nobody" })).status).toBe(404);
    expect((await req(app, "PUT", `${hostsPath}/usr_ghost/role`, OWNER, { role: "viewer" })).status).toBe(
      404,
    );
    expect((await req(app, "DELETE", `${hostsPath}/${COHOST}`, STRANGER)).status).toBe(403);
    expect(publishes).toEqual([]);
  });

  it("not for removing someone who holds no seat, such as the owner", async () => {
    const { hub, publishes } = recordingHub();
    const { app } = buildPublishingApp(hub);
    const res = await req(app, "DELETE", `${hostsPath}/${OWNER}`, OWNER);
    expect(res.status).toBe(200);
    expect(publishes).toEqual([]);
  });

  it("does not fail the write when the hub rejects", async () => {
    const { hub } = recordingHub(true);
    const { db, app } = buildPublishingApp(hub);
    seedCohost(db);
    const res = await req(app, "DELETE", `${hostsPath}/${COHOST}`, OWNER);
    expect(res.status).toBe(200);
    expect(db.select().from(weddingHosts).all()).toHaveLength(0);
  });
});
```

The handle-not-found case reads `HANDLE_TO_PROFILE` at the top of the file, where `"nobody"` is not a key. `already_host` (409) comes from bob's existing seat.

Run: `bun test tests/routes/organiser-hosts.test.ts`
Expected: FAIL — `realtimeHub` is not passed through, so nothing is published.

- [ ] **Step 4: Publish in `routes/organiser-hosts.ts`**

(a) Imports: `import { createWeddingSignals, type WeddingSignals } from "../services/realtime";`

(b) Signature (line 165):

```ts
export const createOrganiserHostsWriteRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
  resolveOsnProfileByHandle?: OsnHandleResolver,
  signals: WeddingSignals = createWeddingSignals(undefined),
) =>
```

Add one sentence to the factory's doc comment: "Each successful write then tells the wedding's open tabs (`signals.membersChanged`); a remove or role change also evicts that co-host's sockets so their access is checked again."

(c) ADD: after `const host = yield* hostsService.add({ … });` (line 228), insert:

```ts
                yield* signals.membersChanged(scopedWeddingId, undefined, request);
```

(d) ROLE CHANGE: after `const host = yield* hostsService.setRole({ … });` (line 319), insert:

```ts
                yield* signals.membersChanged(weddingId, params.osnProfileId, request);
```

(e) REMOVE: add `request` to the handler's destructuring (line 363: `.delete("/hosts/:osnProfileId", ({ request, weddingId, params, set }) => {`). After `Effect.tap(() => Effect.sync(() => metricHostRemoved("ok"))),` (line 371), insert:

```ts
              // Only when a seat went: removing someone who holds none (or the
              // owner, who is never rowed in) changes nobody's access.
              Effect.tap((removed) =>
                removed ? signals.membersChanged(weddingId, params.osnProfileId, request) : Effect.void,
              ),
```

The `Effect.as({ removed: true, osnProfileId: params.osnProfileId })` that follows is unchanged, so the response stays idempotent.

(f) `services/hosts.ts` `remove` (lines 612–639): make it answer whether a seat went, from the same statement. Replace `.run()` with `.returning({ id: weddingHosts.id }).all()`, bind the result (`const removed = yield* Effect.tryPromise({ … })`), end the generator with `return removed.length > 0;`, and change the return type to `Effect.Effect<boolean, HostWriteError, DbService>`. Add to its doc comment: "Answers whether a seat was actually removed, from the same statement (RETURNING), so a caller can act only on a real change." `setRole` already uses `.returning(...).all()` on both D1 and bun:sqlite (`hosts.ts:578-594`), so the form works on both drivers.

In `tests/services/hosts.test.ts` ("removes a host scoped to the wedding and is idempotent", line 312), assert the answers:

```ts
    expect(await run(db, hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: ALICE }))).toBe(
      true,
    );
    expect(db.select().from(weddingHosts).all()).toHaveLength(0);
    // Idempotent — removing again succeeds, and says nothing was removed.
    expect(await run(db, hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: ALICE }))).toBe(
      false,
    );
```

A role change to the role a seat already holds still publishes and evicts. Telling it apart would cost a second D1 read on every role change to save one Durable Object request on a rare case, so the plan accepts it.

Each insertion sits after the service call, on the success path only. A `HostConflict`, `HostNotFound`, `HostWriteError` or `SchemaError` leaves the generator, or skips the `tap`, before it.

- [ ] **Step 5: Pass the signals from `createApp`**

In `app.ts`, destructure `realtimeHub` from options. Before `const app =`, add:

```ts
  // One publisher for the co-host writes. No hub bound ⇒ every signal is a
  // counted no-op and the writes behave exactly as they did before push.
  const weddingSignals = createWeddingSignals(realtimeHub);
```

Change line 781 to pass it:

```ts
        createOrganiserHostsWriteRoutes(db, osnAuthOptions, hostLimiter, resolveOsnProfileByHandle, weddingSignals),
```

This adds an argument, not a `.use()`, so the fluent chain's type depth (the TS2589 comment at lines 946–951) is unchanged.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `bun test --preload ./tests/test-helpers/metrics-harness.ts tests/routes/organiser-hosts.test.ts tests/services/realtime.test.ts tests/services/hosts.test.ts`, from `cire/api`.
Expected: PASS. The existing cases in `organiser-hosts.test.ts` are unchanged, since `buildApp()` without `realtimeHub` publishes nothing.

Run: `bun run --cwd cire/api test`, then `bun run --cwd cire/api check`
Expected: all pass, and exit 0.

- [ ] **Step 7: See the guard fail**

Temporarily delete the `yield* signals.membersChanged(weddingId, params.osnProfileId, request);` line in the role change, and run the route tests: "after a role change" fails. Restore it.

Then replace `removed ? signals.membersChanged(…) : Effect.void` with the bare `signals.membersChanged(…)`: "not for removing someone who holds no seat" fails. Restore it.

Both were seen failing on 2026-09-26.

- [ ] **Step 8: Commit**

```bash
git add cire/api/src/services/realtime.ts cire/api/src/services/hosts.ts cire/api/src/routes/organiser-hosts.ts \
  cire/api/src/app.ts cire/api/tests/services/realtime.test.ts cire/api/tests/services/hosts.test.ts \
  cire/api/tests/routes/organiser-hosts.test.ts
git commit -m "Publish members-changed after every co-host write"
```

---

### Task 6: The organiser portal listens on the open wedding

**Files:**
- Create: `cire/host/src/lib/realtime.ts`
- Modify: `cire/host/src/components/OrganiserApp.tsx` (imports; `recheckWeddings` lines 251–315; after `selected`, line 516)
- Modify: `cire/host/public/_headers` (the `Content-Security-Policy` line, and the trailing comment block)
- Modify: `cire/host/src/lib/tier-headers.ts` (`retargetHeaders` and the module doc)
- Modify: `cire/host/package.json`, `bun.lock`
- Test: `cire/host/tests/lib/realtime.test.ts`, `cire/host/tests/lib/tier-headers.test.ts`, `cire/host/tests/lib/headers.test.ts`, `cire/host/tests/components/OrganiserApp.test.tsx`

**Interfaces:**
- Consumes: `formatTopic` (`@shared/realtime`), `useTopic` (`@shared/realtime/solid`), `SignalEvent` (`@shared/realtime/client`); cire-api's `/realtime/:topic` (Tasks 3–4)
- Produces:
  - `weddingTopicUrl(weddingId: string, apiUrl?: string): string | null`
  - `recheckWeddings(changedAt?: number, retry?: boolean)` — a rename of its `refusedAt` parameter
  - `retargetHeaders` now also rewrites `wss://api.cireweddings.com` to the tier's `ws(s)://` origin

- [ ] **Step 1: Add the dependency and splice `bun.lock`**

In `cire/host/package.json` `dependencies`, add `"@shared/realtime": "workspace:*",` after `"@shared/design-tokens": "workspace:*",`. In `bun.lock`'s `"cire/host"` block (it starts at line 71), add after `        "@shared/design-tokens": "workspace:*",`:

```
        "@shared/realtime": "workspace:*",
```

Run: `bun install --frozen-lockfile && git diff --stat bun.lock`
Expected: succeeds, with +1 line in this task.

- [ ] **Step 2: Write the failing tests for the URL and the CSP**

`cire/host/tests/lib/realtime.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { weddingTopicUrl } from "../../src/lib/realtime";

describe("weddingTopicUrl", () => {
  it("swaps https for wss on the API's origin", () => {
    expect(weddingTopicUrl("wed_a", "https://api.cireweddings.com")).toBe(
      "wss://api.cireweddings.com/realtime/cire%3Awedding%3Awed_a",
    );
  });

  it("swaps http for ws and drops a trailing slash", () => {
    expect(weddingTopicUrl("wed_a", "http://localhost:8787/")).toBe(
      "ws://localhost:8787/realtime/cire%3Awedding%3Awed_a",
    );
  });

  it("is null for an id that cannot form a topic", () => {
    expect(weddingTopicUrl("", "https://api.cireweddings.com")).toBeNull();
    expect(weddingTopicUrl("wed:a", "https://api.cireweddings.com")).toBeNull();
  });
});
```

In `cire/host/tests/lib/headers.test.ts`:
- Change the pinned `connect-src` row (line 63) to `["connect-src", "'self'", "https://api.cireweddings.com", "wss://api.cireweddings.com"],`.
- Change line 94 to `expect(csp).toContain("connect-src 'self' https://api.cireweddings.com wss://api.cireweddings.com;");`.
- Rename that test to "allowlists cire-api, over https and wss, and nothing else for fetches".

The existing "names cire-api only in forms the build can point at another tier" test (lines 140–160) needs no change. It will now fail until `retargetHeaders` learns the `wss://` form, which is the point.

In `cire/host/tests/lib/tier-headers.test.ts`, add inside `describe("retargetHeaders")`:

```ts
  const SOCKET_HEADERS = HEADERS.replace(
    `connect-src 'self' ${PRODUCTION_API_ORIGIN};`,
    `connect-src 'self' ${PRODUCTION_API_ORIGIN} wss://api.cireweddings.com;`,
  );

  it("points the socket source at the tier's API as well", () => {
    expect(retargetHeaders(SOCKET_HEADERS, "https://api.dev.cireweddings.com")).toContain(
      "connect-src 'self' https://api.dev.cireweddings.com wss://api.dev.cireweddings.com;",
    );
    expect(retargetHeaders(SOCKET_HEADERS, "http://localhost:8787")).toContain(
      "connect-src 'self' http://localhost:8787 ws://localhost:8787;",
    );
    expect(retargetHeaders(SOCKET_HEADERS, PRODUCTION_API_ORIGIN)).toBe(SOCKET_HEADERS);
  });

  it("does not touch a socket host that merely starts with the production origin", () => {
    const lookalike = `${SOCKET_HEADERS}# wss://api.cireweddings.com.example wss://api.cireweddings.community\n`;
    const dev = retargetHeaders(lookalike, "https://api.dev.cireweddings.com");
    expect(dev).toContain("wss://api.cireweddings.com.example");
    expect(dev).toContain("wss://api.cireweddings.community");
  });
```

Run: `bun run --cwd cire/host test:run tests/lib/realtime.test.ts tests/lib/tier-headers.test.ts tests/lib/headers.test.ts`
Expected: FAIL — the missing module, the missing `wss` source, and no `wss` rewrite.

- [ ] **Step 3: Write `src/lib/realtime.ts`, the CSP source and the rewrite**

`cire/host/src/lib/realtime.ts`:

```ts
// Where the organiser portal listens for changes to a wedding it shows.
// Frontend code: no Effect.
import { formatTopic } from "@shared/realtime";

import { CIRE_API_URL } from "./osn";

/**
 * The socket URL for one wedding's topic: cire-api's origin with `http`
 * swapped for `ws` (`https` → `wss`), then `/realtime/<topic>`. Null for an id
 * that cannot form a topic — the dashboard then does not listen.
 */
export function weddingTopicUrl(weddingId: string, apiUrl: string = CIRE_API_URL): string | null {
  const topic = formatTopic("cire", "wedding", weddingId);
  if (!topic) return null;
  const base = apiUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/realtime/${encodeURIComponent(topic)}`;
}
```

`cire/host/public/_headers`: in the `Content-Security-Policy` line, change `connect-src 'self' https://api.cireweddings.com;` to `connect-src 'self' https://api.cireweddings.com wss://api.cireweddings.com;`. In the directive notes (the `#   connect-src` entry, lines 90–93), change "cire-api only." to "cire-api only: `https:` for fetches and `wss:` for the realtime socket (`src/lib/realtime.ts`). An `https:` source does not admit a `wss:` URL, so both are listed." In the comment block at the file's end, change "every `https://api.cireweddings.com` above becomes the origin of the `PUBLIC_CIRE_API_URL`" to "every `https://api.cireweddings.com` above becomes the origin of the `PUBLIC_CIRE_API_URL`, and every `wss://api.cireweddings.com` its `ws(s)://` twin". A `connect-src` `https:` source does not match a `wss:` URL (CSP 3 scheme-part matching), so the socket needs its own source.

`cire/host/src/lib/tier-headers.ts`: after `const productionOrigin = …`, add:

```ts
/** The production socket origin, bounded the same way as {@link productionOrigin}. */
const productionSocketOrigin = () => /wss:\/\/api\.cireweddings\.com(?![\w.:-])/g;
```

In `retargetHeaders`, change the return to:

```ts
  return contents
    .replace(productionSocketOrigin(), () => origin.replace(/^http/, "ws"))
    .replace(productionOrigin(), () => origin);
```

In the module doc comment, change "`connect-src`, `img-src`, `report-uri` and `Reporting-Endpoints` all name `https://api.cireweddings.com`" to "…name `https://api.cireweddings.com`, and `connect-src` its socket twin `wss://api.cireweddings.com`". Change "swaps the production origin for the origin of `PUBLIC_CIRE_API_URL`" to "…swaps both for the origin of `PUBLIC_CIRE_API_URL` (`ws://`/`wss://` for the socket)". `bundleNamesOrigin` stays on the `https` origin: the bundle derives the socket URL at runtime from `CIRE_API_URL`, so the `wss` string never appears in it.

- [ ] **Step 4: Run those tests and watch them pass**

Run: `bun run --cwd cire/host test:run tests/lib/realtime.test.ts tests/lib/tier-headers.test.ts tests/lib/headers.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing Dashboard tests** — in `tests/components/OrganiserApp.test.tsx`

Add, beside the other `vi.mock` calls:

```ts
// The Dashboard's subscription, captured rather than opened: a unit test drives
// the signal by hand. The browser tier (`OrganiserApp.realtime.browser.test.tsx`)
// runs the real socket.
const topic = vi.hoisted(() => ({
  url: null as null | (() => string | null | undefined),
  onSignal: null as null | ((event: { reason: string }) => void),
}));
vi.mock("@shared/realtime/solid", () => ({
  useTopic: (url: () => string | null | undefined, onSignal: (event: { reason: string }) => void) => {
    topic.url = url;
    topic.onSignal = onSignal;
  },
}));
```

Reset `topic.url = null; topic.onSignal = null;` in the suite's `afterEach`. Then add, inside `describe("OrganiserApp Dashboard")` after the `shell` helper (line 535):

```ts
  it("listens on the open wedding's topic, and on nothing from the list", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    authFetchMock.mockResolvedValue(listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]));
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    expect(topic.url?.()).toMatch(/\/realtime\/cire%3Awedding%3Awed_a$/);

    fireEvent.click(screen.getByRole("button", { name: /All weddings/i }));
    expect(topic.url?.()).toBeNull();
  });

  it("does not listen for a helper, whose seat holds no rows", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    authFetchMock.mockResolvedValue(
      listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob", role: "helper" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(screen.getByText(/Helper access/i)).toBeTruthy());
    expect(topic.url?.()).toBeNull();
  });

  it("re-reads the list on a signal and drops a wedding the organiser was removed from", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    let removed = false;
    authFetchMock.mockImplementation(async () =>
      listResponse(removed ? [] : [{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]),
    );
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    setCachedVendors("wed_a", [vendorRow("wed_a")]);
    expect(listCalls()).toBe(1);

    removed = true;
    topic.onSignal?.({ reason: "message" });

    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    expect(listCalls()).toBe(2);
    expect(peekCachedVendors("wed_a")).toBeNull();
  });

  it("re-reads at once on a signal, inside the once-a-minute window", async () => {
    history.replaceState(null, "", "#/w/wed_a");
    authFetchMock.mockResolvedValue(listResponse([{ id: "wed_a", slug: "a", displayName: "Alice & Bob" }]));
    render(() => <OrganiserApp />);
    await waitFor(() => expect(shell().textContent).toContain("wed_a"));
    topic.onSignal?.({ reason: "reconnected" });
    await waitFor(() => expect(listCalls()).toBe(2));
  });
```

`vendorRow`, `LIST_URL`, `listCalls` and `shell` are the suite's own helpers (lines 516–535). If `vendorRow` is scoped inside a block, move it to the same scope as the new tests.

Run: `bun run --cwd cire/host test:run tests/components/OrganiserApp.test.tsx`
Expected: FAIL — `topic.url` stays null, because nothing calls `useTopic`.

- [ ] **Step 6: Listen in `OrganiserApp.tsx`**

(a) Imports:

```ts
import { useTopic } from "@shared/realtime/solid";

import { weddingTopicUrl } from "../lib/realtime";
```

Place each in its import group, as oxfmt orders them.

(b) In `recheckWeddings` (lines 251–315), rename the parameter `refusedAt` to `changedAt` in the signature and its two uses. Replace the doc comment's last two paragraphs, from "Runs on any 403 …" through "`refusedAt` is when the refused request was sent, for a 403 trigger.", with:

```ts
   * Runs on any 403 from a wedding route, on a push signal for the open
   * wedding, and — at most once a minute — when the tab comes back into view
   * or the organiser moves within the dashboard. Concurrent triggers share one
   * request, except one that reports a change after that request started: its
   * answer may predate the change, so a new request is sent. An answer is
   * thrown away if the list was written locally while it was in flight (a
   * created wedding, a rename), and then asked for once more; an answer
   * overtaken by a newer request is thrown away too.
   *
   * `changedAt` is when the change is known to have happened by: for a 403,
   * when the refused request was sent; for a push signal, when it arrived.
```

(c) After the `selected` accessor (ending at line 516), add:

```ts
  // While a wedding's dashboard is open, its topic tells this tab the moment
  // the wedding's hosts change — the organiser removed, or narrowed to a role
  // without the dashboard — so the re-read above runs at once instead of on
  // the next refusal or return to the tab. A signal only says "ask again"; the
  // answer is what drops the rows. A socket that cannot be held changes
  // nothing: the other triggers still run. A helper's seat holds no rows, so
  // it does not listen.
  useTopic(
    () => {
      const wedding = selected();
      return wedding && surfacesFor(wedding.role).canOpenDashboard ? weddingTopicUrl(wedding.id) : null;
    },
    () => void recheckWeddings(Date.now()),
  );
```

`useTopic` compares the URL string, so a rename re-runs this accessor without reopening the socket (phase 1 Task 7 pins that).

- [ ] **Step 7: Run the portal's fast tier and its checks**

Run: `bun run --cwd cire/host test:run`
Expected: PASS, including the 4 new Dashboard cases and every existing one.

Run: `bun run --cwd cire/host check`
Expected: `astro check` reports 0 errors.

Run: `bun run --cwd cire/host build`
Expected: the build passes, `CSP in _headers points at http://localhost:8787` is logged, and the bundle-size guard passes. On 2026-09-26 it measured 247,266 bytes gzip against the 252,653 threshold in `scripts/bundle-size-budgets.txt`. Record the printed total. If the guard trips, re-baseline `scripts/bundle-size-budgets.txt` for `cire/host` as that file's header instructs, to the new measured total plus at most about 11.7 KB. Say so in the PR body. Then run `grep -n "connect-src" cire/host/dist/_headers`: it shows `http://localhost:8787 ws://localhost:8787`.

- [ ] **Step 8: Commit**

```bash
git add cire/host/src/lib/realtime.ts cire/host/src/components/OrganiserApp.tsx cire/host/public/_headers \
  cire/host/src/lib/tier-headers.ts cire/host/package.json bun.lock cire/host/tests/lib/realtime.test.ts \
  cire/host/tests/lib/tier-headers.test.ts cire/host/tests/lib/headers.test.ts \
  cire/host/tests/components/OrganiserApp.test.tsx
git commit -m "Re-read the wedding list the moment the open wedding's hosts change"
```

---

### Task 7: Browser test — a removed co-host's idle tab drops the rows

**Files:**
- Modify: `cire/host/tests/test-support/browser-commands.ts`
- Modify: `cire/host/vitest.config.ts` (the browser project's `commands`)
- Test: `cire/host/tests/components/OrganiserApp.realtime.browser.test.tsx`

**Interfaces:**
- Consumes: the Dashboard wiring (Task 6); `@shared/realtime/client` running unmocked in Chromium
- Produces: browser commands `startRealtimeServer(): { port }`, `pushRealtime(frame)`, `dropRealtime(code)`, `realtimeSocketCount(): number`, `stopRealtimeServer()`

Why a real server, and why this one: the spec asks for a browser test. The value this tier adds over Task 6 is the browser's own WebSocket: its open/message/close ordering, and a real close code arriving. Playwright's `context.routeWebSocket` was tried on 2026-09-26 and **does not** intercept a socket the Vitest test iframe opens, because it patches documents at load and the iframe already exists. A `Bun.serve` WebSocket server started from a browser command **does** work, in the same spike, with Chromium from `@vitest/browser-playwright` 4.1.11. The Vitest process is Bun, because the package's `test:browser` script runs `bunx --bun vitest`. The server must be stopped in `afterAll`, or Vitest waits 10 s for the process to exit.

- [ ] **Step 1: Add the commands to `tests/test-support/browser-commands.ts`**

Append, above the `declare module` block:

```ts
type RealtimeSocket = { send(frame: string): void; close(code?: number, reason?: string): void };
type RealtimeServer = { port: number; stop(closeActiveConnections?: boolean): void };
type BunRuntime = { serve(options: unknown): RealtimeServer };

const realtimeSockets = new Set<RealtimeSocket>();
let realtimeServer: RealtimeServer | undefined;

/**
 * Start a WebSocket server the portal's realtime client can reach from the
 * browser, answering `ping` as the hub does. It runs in the Vitest process,
 * which is Bun (`bunx --bun vitest`). Playwright's `routeWebSocket` is no
 * substitute: it patches a document as it loads, and the test iframe already
 * exists by the time a command runs.
 */
export const startRealtimeServer = defineBrowserCommand<[]>(async () => {
  const bun = (globalThis as { Bun?: BunRuntime }).Bun;
  if (!bun) throw new Error("startRealtimeServer needs Bun: run the suite with `bunx --bun vitest`");
  realtimeServer ??= bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request: Request, server: { upgrade(request: Request): boolean }) {
      return server.upgrade(request) ? undefined : new Response(null, { status: 426 });
    },
    websocket: {
      open(ws: RealtimeSocket) {
        realtimeSockets.add(ws);
      },
      message(ws: RealtimeSocket, frame: string) {
        if (frame === "ping") ws.send("pong");
      },
      close(ws: RealtimeSocket) {
        realtimeSockets.delete(ws);
      },
    },
  });
  return { port: realtimeServer.port };
});

/** Send one text frame to every socket the server holds. */
export const pushRealtime = defineBrowserCommand<[string]>(async (_ctx, frame) => {
  for (const ws of realtimeSockets) ws.send(frame);
});

/** Close every socket the server holds with `code`, as a deploy or eviction would. */
export const dropRealtime = defineBrowserCommand<[number]>(async (_ctx, code) => {
  for (const ws of realtimeSockets) ws.close(code, "test drop");
});

export const realtimeSocketCount = defineBrowserCommand<[]>(async () => realtimeSockets.size);

export const stopRealtimeServer = defineBrowserCommand<[]>(async () => {
  realtimeServer?.stop(true);
  realtimeServer = undefined;
  realtimeSockets.clear();
});
```

Extend the `BrowserCommands` augmentation:

```ts
    startRealtimeServer: () => Promise<{ port: number }>;
    pushRealtime: (frame: string) => Promise<void>;
    dropRealtime: (code: number) => Promise<void>;
    realtimeSocketCount: () => Promise<number>;
    stopRealtimeServer: () => Promise<void>;
```

Extend the file's top doc comment by one sentence: "The realtime commands run a WebSocket server in the same process for the portal's push tests."

In `cire/host/vitest.config.ts`, import the five names beside `emulateMedia`, and change `commands: { emulateMedia },` to `commands: { emulateMedia, startRealtimeServer, pushRealtime, dropRealtime, realtimeSocketCount, stopRealtimeServer },`.

- [ ] **Step 2: Write the browser test `tests/components/OrganiserApp.realtime.browser.test.tsx`**

```tsx
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";

/**
 * The one thing about push only a real browser can answer: does an idle,
 * untouched tab drop a wedding the organiser was removed from, over the
 * browser's own WebSocket? Everything but the socket is stubbed as in
 * `OrganiserApp.test.tsx`; the subscription itself (`@shared/realtime`) runs
 * for real against a WebSocket server the Vitest process holds.
 */

const realtime = vi.hoisted(() => ({ base: "" }));
const authFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@shared/rp-auth/solid", async () => {
  const { createContext, useContext } = await import("solid-js");
  const base = {
    authFetch: (...args: unknown[]) => authFetchMock(...args),
    logout: async () => {},
    session: () => ({
      osnProfileId: "usr_cohost",
      displayName: "Co Host",
      handle: "cohost",
      email: null,
      avatarUrl: null,
      expiresAt: "2099-01-01T00:00:00Z",
    }),
  };
  const AuthContext = createContext<typeof base>();
  return {
    AuthContext,
    AuthProvider: (props: { children: unknown }) => props.children,
    useAuth: () => useContext(AuthContext) ?? base,
  };
});
// Every name the portal imports from it: in the browser a missing named export
// is a SyntaxError at import, not an undefined at use.
vi.mock("@shared/toast", () => ({
  Toaster: () => null,
  toast: { success: () => {}, error: () => {} },
}));
// The same shape `PreviewInviteButton.browser.test.tsx` mocks it with.
// `test-support/mocks`' `organiserApiMock` cannot be loaded from a
// browser-mode factory.
vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    apiUrl: (path: string) => `https://api.test${path}`,
    isAuthExpired: () => false,
    redirectToLogin: () => {},
  };
});
// Point the dashboard's topic at the command-held server instead of cire-api.
vi.mock("../../src/lib/realtime", () => ({
  weddingTopicUrl: (weddingId: string) =>
    `${realtime.base}/realtime/${encodeURIComponent(`cire:wedding:${weddingId}`)}`,
}));
// Plain DOM nodes, not JSX, and built through `vi.hoisted`: a browser-mode
// factory runs before the file's imports and top-level consts, and compiled
// JSX calls `solid-js/web` helpers imported at the top. A Solid component may
// return a DOM node.
const { testNode } = vi.hoisted(() => ({
  testNode: (testId: string, text = ""): HTMLElement => {
    const node = document.createElement("div");
    node.dataset.testid = testId;
    node.textContent = text;
    return node;
  },
}));
vi.mock("../../src/components/WeddingList", () => ({
  default: () => testNode("wedding-list"),
}));
vi.mock("../../src/components/ModuleShell", () => ({
  default: (props: { weddingId: string }) => testNode("module-shell", props.weddingId),
}));
vi.mock("../../src/components/PreviewInviteButton", () => ({ default: () => null }));
vi.mock("../../src/components/SecurityPanel", () => ({ default: () => null }));

import OrganiserApp from "../../src/components/OrganiserApp";
import { __resetVendorsCache, peekCachedVendors, setCachedVendors, type VendorRow } from "../../src/lib/vendors-store";
import { __resetWeddingScope } from "../../src/lib/wedding-scope";

// The same row `OrganiserApp.test.tsx` caches (its `vendorRow`, lines 516–531).
const vendorRow = (weddingId: string): VendorRow => ({
  id: `ven_${weddingId}`,
  weddingId,
  directoryVendorId: null,
  name: "Florist",
  category: "florals",
  status: "researching",
  contactName: "Sam",
  email: "sam@example.com",
  phone: "0400 000 000",
  notes: null,
  quotedMinor: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
});

function listResponse(weddings: { id: string; role?: string }[]) {
  return new Response(
    JSON.stringify({
      weddings: weddings.map((w) => ({
        slug: w.id,
        displayName: w.id,
        role: "editor",
        entitlements: [],
        guestCap: 100,
        ...w,
      })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const SIGNAL = JSON.stringify({ topic: "cire:wedding:wed_a", kind: "members-changed", at: 1 });

beforeAll(async () => {
  const { port } = await commands.startRealtimeServer();
  realtime.base = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await commands.stopRealtimeServer();
});

afterEach(() => {
  cleanup();
  authFetchMock.mockReset();
  __resetWeddingScope();
  __resetVendorsCache();
  history.replaceState(null, "", window.location.pathname + window.location.search);
});

async function openRemovableWedding(): Promise<{ remove: () => void }> {
  history.replaceState(null, "", "#/w/wed_a");
  let removed = false;
  authFetchMock.mockImplementation(async () => listResponse(removed ? [] : [{ id: "wed_a" }]));
  render(() => <OrganiserApp />);
  await waitFor(() => expect(screen.getByTestId("module-shell").textContent).toContain("wed_a"));
  setCachedVendors("wed_a", [vendorRow("wed_a")]);
  await expect.poll(() => commands.realtimeSocketCount()).toBe(1);
  return { remove: () => (removed = true) };
}

describe("OrganiserApp — push, in a real browser", () => {
  it("drops a removed co-host's rows from an idle tab, with no interaction", async () => {
    const wedding = await openRemovableWedding();

    wedding.remove();
    await commands.pushRealtime(SIGNAL);

    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    expect(peekCachedVendors("wed_a")).toBeNull();
    // Off the wedding, the tab stops listening.
    await expect.poll(() => commands.realtimeSocketCount()).toBe(0);
  });

  it("re-reads when the socket is dropped, as on a deploy or an eviction", async () => {
    const wedding = await openRemovableWedding();

    wedding.remove();
    await commands.dropRealtime(4001);

    await waitFor(() => expect(screen.getByTestId("wedding-list")).toBeTruthy());
    expect(peekCachedVendors("wed_a")).toBeNull();
  });
});
```

- [ ] **Step 3: Run the browser tier and watch the new file pass**

Run: `bun run --cwd cire/host test:browser`
Expected: PASS, including the 2 new cases, and the process exits promptly. A 10-second "close timed out" means `stopRealtimeServer` did not run.

- [ ] **Step 4: See it fail**

Temporarily replace the `useTopic(…)` call in `OrganiserApp.tsx` with nothing, and re-run `bun run --cwd cire/host test:browser`.
Expected: both new cases fail — the socket count never reaches 1. Restore the call.

- [ ] **Step 5: Commit**

```bash
git add cire/host/tests/test-support/browser-commands.ts cire/host/vitest.config.ts \
  cire/host/tests/components/OrganiserApp.realtime.browser.test.tsx
git commit -m "Prove in Chromium that an idle tab drops a wedding its co-host lost"
```

---

### Task 8: Wiki, changeset, gates and the human deploy walk

**Files:**
- Modify: `wiki/cire/cire-host-portal-layout.md` (§"Noticing a lost wedding", lines 366–397)
- Modify: `wiki/cire/cire-auth.md` (§"Authorisation: wedding ownership", the gate list at lines 146–180)
- Modify: `wiki/shared/realtime.md` (add "Adopters")
- Modify: `wiki/shared/free-tier-limits.md` (dependency map; Rate Limiting row)
- Modify: `wiki/shared/dev-environment.md` (the resource table at lines ~50–57)
- Modify: `wiki/cire/cire.md` (line 107 "entry `src/index.ts`"; lines 137–139 bindings sentence)
- Create: `.changeset/cire-realtime-push.md`

- [ ] **Step 1: Load the skills** — `write-wiki`, then `obsidian:obsidian-markdown`.

- [ ] **Step 2: Update the pages**

- `cire-host-portal-layout.md` §"Noticing a lost wedding":
  - Add a first bullet to the trigger list: "**a push signal for the open wedding.** `Dashboard` listens on `cire:wedding:<id>` with `useTopic` (`@shared/realtime/solid`) while a wedding's dashboard is open, and not for a helper's seat. A signal, a dropped socket and a reconnect each re-read the list at once, outside the once-a-minute limit. See [[realtime]]."
  - Delete the sentence "Nothing pushes a change to a tab left untouched. It waits for the tab's next request, move or return to view."
  - Replace it with: "When push is unavailable (no hub on the tier, the socket blocked, or six failed attempts), a tab left untouched waits for its next request, move or return to view."
  - Set `last-reviewed`.
- `cire-auth.md`, as a new bullet after `weddingRunSheet()`: "**`GET /realtime/:topic`** (`cire/api/src/routes/realtime.ts`) — not an Elysia route: the Worker entry answers it before the app, because Elysia rebuilds a returned `Response` and a rebuilt 101 loses its socket. It resolves the organiser as `osnAuth()` does (`resolveOsnProfileId`), limits them per organiser (`REALTIME_RATE_LIMITER`, 30/min), then applies the `member` capability exactly as `weddingMember()` does: owner, editor and viewer are admitted, and a helper, a stranger or an unknown wedding all get the same **403**. `Origin` must equal the organiser portal's exactly. It never upgrades a refusal." Set `last-reviewed`.
- `realtime.md`, a new section `## Adopters`: "**cire** — hub bound as `REALTIME_HUB` in `cire/api/wrangler.toml` (entry `src/entry.ts`); route `GET /realtime/:topic`; publishes `members-changed` on `cire:wedding:<id>` after a co-host add, role change or removal, evicting the co-host whose seat changed; the host portal's `Dashboard` listens on the open wedding. See [[cire-auth]] and [[cire-host-portal-layout]]." Set `last-reviewed`.
- `free-tier-limits.md`:
  - Add a dependency-map row: `| **Cloudflare Durable Objects** | **cire-api** \`REALTIME_HUB\` (\`TopicHub\`, realtime push — [[realtime]]) | osn-api |`.
  - In the Rate Limiting binding row, add `REALTIME_RATE_LIMITER` (realtime subscribe) beside `CLAIM_RATE_LIMITER`.
  - Set `last-reviewed`.
- `dev-environment.md`:
  - In the resource table, add `1106` to the dev rate-limit namespaces and `1006` to production's.
  - Add a row: `| Durable Object namespace | the dev Worker's own \`TopicHub\` namespace | the production Worker's |`.
  - Set `last-reviewed`.
- `cire.md`:
  - Line 107: "(entry `src/index.ts`)" becomes "(entry `src/entry.ts`, which re-exports the handler in `src/index.ts` and the realtime hub class)".
  - Lines 137–139: "redeclares the D1 + R2 bindings" becomes "redeclares the D1, R2, rate-limit and Durable Object bindings".
  - A new subsection `### Turning realtime push off`, with the text of "Turning push off" below.
  - A sentence in the realtime paragraph: "Seed runs (the nightly dev rebuild) and data migrations change `wedding_hosts` with no signal. Open tabs catch up on their next refetch. A helper's seat does not listen, so when a helper view (the run sheet) ships, it must subscribe too."
  - Set `last-reviewed`.

**Turning push off.** The text for `wiki/cire/cire.md`, and for the PR body:

> After the first deploy, reverting this change is not enough on its own. A revert removes the `TopicHub` export from `src/entry.ts` and the `v1` migration. Wrangler then refuses the upload, because existing Durable Objects depend on the class. So `deploy-cire-api-dev` fails, and `deploy-cire-api` waits on it (`.github/workflows/deploy.yml` lines 278–377). To turn push off, delete the three `REALTIME_HUB` binding blocks from `cire/api/wrangler.toml` and deploy. `/realtime/*` then answers 503, publishes do nothing, tabs fall back, and the class export and migration stay. Removing the class itself needs a new migration with `deleted_classes = ["TopicHub"]`, deployed first.

- [ ] **Step 3: Write `.changeset/cire-realtime-push.md`**

```markdown
---
"@cire/api": minor
"@cire/host": minor
---

Push a co-host change to every open organiser tab. cire-api binds the
`@shared/realtime` hub (`REALTIME_HUB`, exported from the new Worker entry
`src/entry.ts`), answers `GET /realtime/:topic` before the Elysia app, and
publishes `members-changed` on `cire:wedding:<id>` after a co-host is added,
re-roled or removed — closing the affected co-host's sockets so their access is
checked again. The host portal listens on the open wedding and re-reads the
wedding list on a signal, so a removed or narrowed co-host's idle tab drops the
wedding's rows within seconds. The portal's CSP now allows the `wss:` origin.
With no hub bound, everything behaves as before.
```

- [ ] **Step 4: Run every gate and record the real output**

From the repo root. A gate you did not run is `NOT RUN`.

```bash
bun install --frozen-lockfile && git diff --stat origin/main...HEAD -- bun.lock
bun run --cwd cire/api check && bun run --cwd cire/api test
bun run --cwd cire/api test:d1
bun run --cwd cire/api build
(cd cire/api && bunx wrangler deploy --dry-run --env dev --outdir /tmp/cire-api-dev)
(cd cire/api && bunx wrangler deploy --dry-run --env production --outdir /tmp/cire-api-prod)
bun run --cwd cire/host check && bun run --cwd cire/host test:run
bun run --cwd cire/host test:browser
bun run --cwd cire/host build
bun run check:jest-dom-markers && bun run lint && bun run fmt:check
git diff --name-only origin/main...HEAD | bash scripts/changeset-required.sh
./scripts/validate-changesets.sh
```

Expected results:

- `bun.lock` shows +2 lines over phase 1.
- Every suite passes.
- All three dry runs list `env.REALTIME_HUB (TopicHub)`.
- The host build logs the CSP origin and passes the size guard.
- Lint shows no new warnings.
- The changeset script says `required`, and the changeset is present.

- [ ] **Step 5: Commit**

```bash
git add wiki/cire/cire-host-portal-layout.md wiki/cire/cire-auth.md wiki/shared/realtime.md \
  wiki/shared/free-tier-limits.md wiki/shared/dev-environment.md wiki/cire/cire.md .changeset/cire-realtime-push.md
git commit -m "Document cire's realtime push: the route, the publish points, the portal"
```

- [ ] **Step 6: Put the human deploy walk in the PR body** (it cannot run in CI)

After the merge deploys the dev tier:

1. Open `https://host.dev.cireweddings.com` on a wedding. In DevTools → Network → WS, a request to `wss://api.dev.cireweddings.com/realtime/cire%3Awedding%3A<id>` shows `101 Switching Protocols`, with `ping` answered by `pong` every 25 s. There are no CSP violation reports in `bunx wrangler tail --env dev` from `cire/api`.
2. In a second browser, as the owner, remove the first browser's co-host. Within seconds, and with no interaction, the first browser returns to the wedding list.
3. **The Free-plan gate.** Keep one dev portal tab open and visible on a wedding for one hour, touching nothing. Then read the dev Worker's `TopicHub` requests and duration for that hour in Cloudflare dashboard → Workers & Pages → Durable Objects.
   - About 1–3 requests (the connect, plus any deploy reconnect): pings are free.
   - About 7: they are billed at 20:1.
   - About 144 (3,600 s ÷ 25 s): they are billed 1:1.

   Duration should stay near zero between signals. Stop before production if pings are billed 1:1, or if duration climbs while the socket sits idle. Report the figures to the owner (phase 1, Open question 2) with the account's daily request total from `scripts/check-free-tier-ceilings.ts`. That script does not watch Durable Objects yet, so file an issue to add their daily requests and duration to its `CEILINGS`, and link it from `wiki/shared/free-tier-limits.md`.
4. Production (after approval): repeat step 1 on `host.cireweddings.com`. The first production deploy applies migration `v1`. `wrangler deploy` reports the new class. From then on, push is turned off with the binding, not with a revert ("Turning push off" above).

---

## Open questions

1. **The client fallback metric** is carried over from phase 1. The portal passes no `onFallback`, so a tab that fell back is invisible. **Owner:** accept that until browser telemetry exists, or ask for a beacon endpoint.
2. **The co-host panel itself does not refresh on a signal.** On a signal the Dashboard re-reads the wedding list, as the spec says. A second co-host who has `HostsPanel` open still shows the old host list until they reopen it, and an add changes nothing any listener shows. **Owner:** leave it (the spec's scope), or file a follow-up to re-read `GET /hosts` on the same signal.
3. **Revoked OSN sessions keep their sockets.** When osn-api revokes a connection or deletes an account, `POST /internal/revoke-organiser-sessions` revokes cire sessions (`cire/api/src/routes/internal-revoke.ts`). It does not touch `wedding_hosts`, so nothing is published and an open socket stays open until the tab closes. A socket carries only "something changed" and the next re-read 401s, so nothing leaks beyond timing. **Owner:** accept, or evict by subject across the profile's weddings in a follow-up.
4. **Ping billing** (phase 1, Open question 2) is decided by the Task 8 walk's step 3, before production.
5. **Helpers get no push.** A helper's seat does not listen, because it holds no dashboard rows today (`wiki/cire/cire-auth.md`: no run-sheet route is mounted yet). When the run sheet ships, its view must subscribe. **Owner:** a note on the run-sheet issue.

## Stress-plan findings (attacker, 2026-09-26) and how each was closed

| # | Finding | Outcome |
|---|---|---|
| 1 | No rollback once the first deploy creates the class | **Fixed.** Task 8 adds "Turning push off": delete the binding, keep the export and migration. It goes in `wiki/cire/cire.md` and the PR body. |
| 2 | The CSP claim misreads the spec: `https:` may already admit `wss:` | **Rejected, with a measurement.** Chromium 151 blocks a `wss:` socket under an `https:`-only `connect-src` and opens it once `wss:` is listed, and likewise for `ws:`/`http:` (Review Focus 5). The `wss:` source stays; the claim now cites the measurement instead of the spec. |
| 3 | Publishing on add has no visible effect | **Partly fixed.** The goal no longer promises it. The add publish stays because the spec asks for it (Task 5), and the panel refresh is Open question 2. |
| 4 | The publish delays the write's response | **Fixed.** `WeddingSignals` runs the publish in the request's `waitUntil`. A test with a hung hub fails without it. |
| 5 | No test proves the `REALTIME_RATE_LIMITER` binding is wired | **Fixed.** A Task 4 entry test gets 429 from a failing binding and fails with the wiring line deleted. |
| 6 | The cost model leaves out pings; no watcher covers Durable Objects | **Fixed** in the constraints and the phase 1 fit. Walk step 3 is now a per-tab-hour request gate with thresholds, and step 3 files the ceiling-watcher issue (identifiers for the Durable Objects dataset were not verified, so no code is planned for it). |
| 7 | The Worker entry first runs on workerd at the dev deploy | **Fixed.** `tests/workerd/entry.test.ts` boots wrangler's bundle in Miniflare, answers `/realtime`, and calls the hub RPC. Both red checks were seen. |
| 8 | The local dev server answers 404, not 503 | **Fixed** in Review Focus 4 and both doc comments. |
| 9 | "Only three methods write `wedding_hosts`" holds for the runtime only | **Fixed.** The claim is scoped to the runtime; seeds and migrations are named, with a wiki line. |
| 10 | The CORS assertion passes with the route deleted | **Fixed.** It now uses the portal's origin with no session (401). All four entry tests fail with the dispatch removed. |
| 11 | `organiserOrigin` has two defaults | **Fixed.** The doc comment names both readers and both defaults. |
| 12 | The new host tests risk a 429 from the shared limiter | **Fixed** before the attack; the execution run hit it (`buildPublishingApp`). |
| 13 | A wrong count; the unit project is not happy-dom | **Fixed**: 21 route cases, and the environment is described correctly. |
| 14 | One co-host can fill the 50-socket cap | **Fixed in phase 1:** a 5-socket cap per member, and stale-socket culling at the cap. |
| 15 | Helpers get no push | **Recorded**: a wiki line and Open question 5. There is no code change while no helper view holds rows. |
| 16 | Idempotent writes still publish and evict | **Fixed for remove.** `hostsService.remove` answers whether a seat went, and a no-op remove (including the owner's id) publishes nothing; tested with a red check. **Rejected for a same-role change:** telling it apart costs a second D1 read on every role change to save one DO request on a rare case. |
