import { AsyncLocalStorage } from "node:async_hooks";

/**
 * D1 Sessions API wiring: route every query a request makes through one D1
 * session, so read replicas can serve the second and later queries.
 *
 * ## Why
 *
 * Without a session, each `prepare()` is an independent query and D1 sends all
 * of them to the primary database. cire's primary lives in Oceania, so a
 * request served from a European or North American colo pays the full
 * round-trip to Sydney *per query* — a request that reads three tables pays it
 * three times. With read replication enabled, a session pins the first query to
 * the primary and lets every later query in the same session be served by any
 * replica that has caught up to the bookmark the first query returned. The
 * round trips collapse from N × (distance to Sydney) to one, plus N-1 local
 * reads.
 *
 * This is safe to deploy BEFORE replication is turned on: with no replicas, a
 * session behaves exactly like today (every query goes to the primary), so the
 * change is inert until the database has replicas to serve from.
 *
 * ## The constraint, and why it is `first-primary`
 *
 * {@link D1_SESSION_CONSTRAINT} is `"first-primary"`, never
 * `"first-unconstrained"`. `first-primary` sends the first query of the session
 * to the primary, so a request ALWAYS observes every write committed before it
 * started — the ordinary read-your-writes expectation, including across
 * requests (a guest who RSVPs and then reloads, an organiser who saves an edit
 * and then re-reads it). `first-unconstrained` gives that up for one saved
 * round trip on the first query, and cire has at least one route that
 * explicitly cannot take it: `routes/invite.ts` serves a `no-store`,
 * edit-sensitive payload precisely so organiser edits surface on the guest
 * invite's revalidation. One constraint for the whole Worker keeps that
 * property from depending on which route happened to be reached.
 *
 * ## How it threads through
 *
 * The Elysia app graph is built ONCE per isolate (see `index.ts`) with the
 * Drizzle handle baked in, and ~50 route factories close over that handle — so
 * a per-request Drizzle client is not something the app can be handed. Instead
 * the handle is built over a *stable* client shim whose `prepare`/`batch`
 * delegate to whichever session is current on the async context, established
 * per request by {@link runInD1Session}. Outside a session (unit tests, the
 * bun:sqlite dev server, a handler that somehow escaped the async context) the
 * shim falls through to the raw binding, which is exactly today's behaviour —
 * so losing the context degrades to "always primary", never to a wrong answer.
 *
 * That degradation covers a *missing* session only. A binding that cannot open
 * one at all is a different thing: {@link runInD1Session} calls `withSession`
 * unguarded on purpose, so a D1 binding without it fails the request loudly
 * rather than quietly serving every request off the primary forever.
 *
 * ## Why concurrent requests cannot see each other's session
 *
 * The whole design rests on two in-flight requests never sharing a store, and
 * that property is not something this package owns — it comes from how Effect
 * schedules fibers. Every service read runs through `dbQuery` →
 * `Effect.promise`, so all queries execute inside fiber drains; if Effect
 * drained several fibers in one shared microtask, that microtask would carry a
 * single fiber's async context and every other fiber's queries would ride the
 * wrong session. Since Effect 3.20 it does not: `SchedulerRunner.cached` keeps
 * runners in a `WeakMap` keyed by fiber, so each fiber's drain microtask is
 * created inside that fiber's own context. The shared fallback runner is used
 * only when there is no fiber at all.
 *
 * Two consequences worth keeping in mind:
 *
 *  - The interleaved-requests test in `d1-session.test.ts` is the regression
 *    guard for exactly this, and it fails under the old shared-runner
 *    behaviour. It is load-bearing, not belt-and-braces — do not delete it as
 *    redundant, and re-run it deliberately on an `effect` major bump.
 *  - **Module-scope Effect primitives that suspend one request's fiber and
 *    resume it from another's are incompatible with this design.** A shared
 *    `Deferred`, `Semaphore`, `Queue`, `Effect.cached` value or forked daemon
 *    fiber schedules its resume task from whichever fiber completed it, so the
 *    woken fiber's next drain is created inside the *completing* request's
 *    context and its queries would ride that request's session. `@cire/api`
 *    uses none today. Anything of that shape needs the session captured and
 *    re-established explicitly with {@link withD1Session}.
 */

/**
 * The half of `D1Database` that Drizzle's D1 driver actually calls.
 * `drizzle-orm@0.45.2`'s `d1/session.js` uses `client.prepare(sql)` and
 * `client.batch(statements)` and nothing else — no `exec`, no `dump` — which is
 * also exactly what a `D1DatabaseSession` exposes. Naming the narrow type here
 * lets a session stand in for a database without pretending it is one.
 */
export type D1QueryClient = Pick<D1Database, "prepare" | "batch">;

/**
 * Sequential consistency for every request. See the module docs above for why
 * this is not `"first-unconstrained"`.
 */
export const D1_SESSION_CONSTRAINT = "first-primary" as const;

const currentSession = new AsyncLocalStorage<D1QueryClient>();

/**
 * A D1 client that sends each query to the session current on the async
 * context, falling back to `fallback` (the raw binding) when there is none.
 *
 * Stable for the life of the isolate: build the Drizzle handle over this once,
 * and every request routes itself.
 */
export function createSessionRoutedClient(fallback: D1QueryClient): D1QueryClient {
  const active = (): D1QueryClient => currentSession.getStore() ?? fallback;
  return {
    prepare: (query) => active().prepare(query),
    batch: <T>(statements: D1PreparedStatement[]) => active().batch<T>(statements),
  };
}

/**
 * Run `body` with `session` as the client every query routes to.
 *
 * Separate from {@link runInD1Session} so a caller that needs the session
 * object itself — to read `getBookmark()`, or a test asserting the routing — can
 * create it, hand it over, and still hold a reference.
 */
export function withD1Session<T>(session: D1QueryClient, body: () => T): T {
  return currentSession.run(session, body);
}

/**
 * Open a fresh D1 session on `d1` and run `body` inside it. Called once per
 * Worker invocation (`fetch` and `scheduled`), wrapping the whole dispatch.
 *
 * `withSession()` is local object construction — no network — so this costs
 * nothing per request beyond the allocation.
 *
 * Deliberately unguarded: a D1 binding is required to have `withSession`, and a
 * binding that does not (a stub, a wrong binding type) is a misconfiguration
 * worth a loud failure rather than a silent lifetime of primary-only reads.
 */
export function runInD1Session<T>(d1: D1Database, body: () => T): T {
  return withD1Session(d1.withSession(D1_SESSION_CONSTRAINT), body);
}
