import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Miniflare } from "miniflare";

import { D1_SESSION_CONSTRAINT } from "../src/db/d1-session";
import { DDL } from "../src/db/setup";
import handler from "../src/index";
import { jsonBody } from "./test-helpers";

// Boot-time behaviour of the Worker entry point. The organiser dashboard must
// serve ANY authenticated OSN user with NO special bootstrap config — there is
// no global boot gate. Previously `ensureBootstrapOwner` THREW (⇒ 503) in any
// deployed env unless `BOOTSTRAP_OWNER_PROFILE_ID` named a real `usr_*`; that
// gate is gone now that multi-wedding + create-wedding exist. These tests boot
// the real `handler.fetch` against a workerd-backed D1 (Miniflare) in a
// deployed-tier env (`OSN_ENV=production`) with NO bootstrap owner set and
// assert the app boots + routes — i.e. it never fail-closes at the edge with a
// 503 for the missing var.
//
// The tier travels on the `env` BINDING, not `process.env` — on workerd
// `process.env` is unpopulated during module evaluation and only fills lazily,
// so `index.ts` reads `env.OSN_ENV`. These tests therefore set the tier in the
// env object passed to `handler.fetch`, and clear `process.env.OSN_ENV` in
// `beforeAll` so the two can never disagree (a disagreement is what
// `loadConfig`'s S-L3 guard exists to catch, and it throws).

let mf: Miniflare;
let DB: D1Database;
let savedOsnEnv: string | undefined;

const MF_HOOK_TIMEOUT_MS = 30_000;

// A stand-in for the native Workers rate-limit binding — matches
// `WorkersRateLimitBinding` (`{ limit({ key }): Promise<{ success }> }`).
// `success: true` = never limited, which is all these boot tests need.
const fakeRateLimiter = { limit: async () => ({ success: true }) };

const BASE_ENV = {
  // Deployed tier, carried on the binding exactly as wrangler's [env.*.vars]
  // deliver it. `isDeployedTier()` parses this; absent ⇒ `local`.
  OSN_ENV: "production",
  WEB_ORIGIN: "https://app.example.com",
  OSN_JWKS_URL: "https://id.example.com/.well-known/jwks.json",
  OSN_ISSUER_URL: "https://id.example.com",
  OSN_AUDIENCE: "osn-access",
  // Deployed-tier boots now REQUIRE the claim rate-limit binding (fail-closed);
  // supply it so these tests exercise the happy boot path, not the guard.
  CLAIM_RATE_LIMITER: fakeRateLimiter,
};

// Minimal concrete stand-in for the ambient `Span` abstract class — these
// boot tests never actually create a span, so the shape only needs to
// satisfy `Tracing.Span`'s constructor type.
class StubSpan {
  get isTraced(): boolean {
    return false;
  }
  setAttribute(_key: string, _value: boolean | number | string): this {
    return this;
  }
  setAttributes(_attributes: Record<string, boolean | number | string | undefined>): this {
    return this;
  }
  // `recordException` became a required member of `Span` in
  // @cloudflare/workers-types 5.20260903.1. Typed off the interface rather
  // than restated, so the next daily types release cannot silently drift the
  // stub away from the real signature. Nothing in the boot path records an
  // exception, so it does nothing.
  recordException(_exception: Parameters<Span["recordException"]>[0]): void {}
  end(): void {}
}

const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: undefined,
  // `exports` and `abort` became required members of `ExecutionContext` in
  // @cloudflare/workers-types 5. Neither is reachable from a boot test: the
  // handler never looks up a sibling entrypoint, and nothing aborts the
  // invocation.
  exports: {},
  abort: () => {},
  tracing: {
    enterSpan: () => {
      throw new Error("tracing not available in this test context");
    },
    startActiveSpan: () => {
      throw new Error("tracing not available in this test context");
    },
    startSpan: () => {
      throw new Error("tracing not available in this test context");
    },
    Span: StubSpan,
  },
};

beforeAll(async () => {
  // Clear the ambient tier so every case is driven purely by its `env` binding.
  // Leaving `process.env.OSN_ENV = "production"` here would trip `loadConfig`'s
  // S-L3 mismatch guard the moment a case asks for a non-production tier — the
  // guard is right to throw, since on a real Worker both values come from the
  // same wrangler [vars] and can never disagree.
  savedOsnEnv = process.env.OSN_ENV;
  delete process.env.OSN_ENV;
  delete process.env.BOOTSTRAP_OWNER_PROFILE_ID;

  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: "cire-test-index" },
  });
  DB = await mf.getD1Database("DB");
  // Apply the schema the migrations would produce — crucially with NO seeded
  // bootstrap wedding row, mirroring a deployed D1 after migration 0015. D1's
  // exec runs newline-separated statements in one round-trip; collapse internal
  // whitespace so each statement is on a single line as exec expects.
  const ddl = DDL.split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join(";\n");
  await DB.exec(ddl);
}, MF_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await mf?.dispose();
  if (savedOsnEnv === undefined) delete process.env.OSN_ENV;
  else process.env.OSN_ENV = savedOsnEnv;
});

describe("Worker boot (no bootstrap-owner config)", () => {
  it("boots + serves WITHOUT BOOTSTRAP_OWNER_PROFILE_ID in a deployed env (no 503)", async () => {
    const env = { ...BASE_ENV, DB } as unknown as Parameters<NonNullable<typeof handler.fetch>>[1];
    const res = await handler.fetch!(
      new Request("https://api.example.com/api/organiser/weddings"),
      env,
      ctx,
    );
    // The old boot gate would 503 here ("Worker misconfigured: ..."). Now the
    // app boots and the route's own auth gate answers 401 (no token) — proving
    // the edge handler served the request rather than fail-closing on a missing
    // bootstrap owner.
    expect(res.status).not.toBe(503);
    expect(res.status).toBe(401);
  });

  it("still fail-closes 503 when a genuinely required binding/var is missing", async () => {
    // WEB_ORIGIN omitted — the real misconfiguration guard must still fire.
    const env = {
      DB,
      OSN_ENV: BASE_ENV.OSN_ENV,
      OSN_JWKS_URL: BASE_ENV.OSN_JWKS_URL,
      OSN_ISSUER_URL: BASE_ENV.OSN_ISSUER_URL,
      OSN_AUDIENCE: BASE_ENV.OSN_AUDIENCE,
      CLAIM_RATE_LIMITER: fakeRateLimiter,
    } as unknown as Parameters<NonNullable<typeof handler.fetch>>[1];
    const res = await handler.fetch!(
      new Request("https://api.example.com/api/organiser/weddings"),
      env,
      ctx,
    );
    expect(res.status).toBe(503);
  });
});

// C1/C4 fail-closed guard: the native claim rate-limit binding is MANDATORY in
// any deployed tier. Absent, createApp would silently fall back to a per-isolate
// in-memory limiter — no real cross-request brute-force defence on the guest
// claim endpoint. The guard 503s at the edge in a deployed tier, but keeps the
// in-memory fallback in `local` so `bun run dev` / tests boot without it.
// Tier is read from the `OSN_ENV` BINDING (parsed by @shared/observability's
// `parseDeploymentEnvironment`), so each case drives it by setting OSN_ENV in
// the env object — not `process.env`, which is empty on workerd at the moment
// this decision is made.
describe("CLAIM_RATE_LIMITER fail-closed guard", () => {
  const runFetch = (env: Record<string, unknown>) =>
    handler.fetch!(
      new Request("https://api.example.com/api/organiser/weddings"),
      { DB, ...env } as unknown as Parameters<NonNullable<typeof handler.fetch>>[1],
      ctx,
    );

  // BASE_ENV minus the native limiter binding, at the requested tier.
  const withoutBindingAt = (tier: string) => {
    const { CLAIM_RATE_LIMITER: _omit, ...rest } = BASE_ENV;
    void _omit;
    return { ...rest, OSN_ENV: tier };
  };

  it("fail-closes 503 in a deployed tier when the binding is absent", async () => {
    const res = await runFetch(withoutBindingAt("production"));
    expect(res.status).toBe(503);
    expect(await jsonBody(res)).toEqual({
      error: "Worker misconfigured: missing CLAIM_RATE_LIMITER binding",
    });
  });

  it("also fail-closes 503 in the `dev` deployed tier when the binding is absent", async () => {
    const res = await runFetch(withoutBindingAt("dev"));
    expect(res.status).toBe(503);
  });

  it("boots (in-memory fallback) in the `local` tier when the binding is absent", async () => {
    const res = await runFetch(withoutBindingAt("local"));
    // Not the guard's 503 — the app boots and the route's own auth gate answers
    // 401 (no token), proving the in-memory fallback path was taken locally.
    expect(res.status).not.toBe(503);
    expect(res.status).toBe(401);
  });

  it("treats an ABSENT OSN_ENV binding as `local` (in-memory fallback)", async () => {
    // Regression guard for the shape of the prod defect this replaced: with the
    // tier unset the Worker must not pretend to be deployed. It is the wrangler
    // [env.*.vars] entry, present in every deployed env block, that flips this —
    // so an env block that forgets OSN_ENV degrades the claim-endpoint defence
    // silently. That is why the deploy runbook checks the tier in `wrangler tail`.
    const { OSN_ENV: _omit, ...withoutTier } = withoutBindingAt("local");
    void _omit;
    const res = await runFetch(withoutTier);
    expect(res.status).toBe(401);
  });

  it("boots (native binding) in a deployed tier when the binding is present", async () => {
    const res = await runFetch(BASE_ENV);
    // Binding present ⇒ no guard 503; app boots and the route answers 401.
    expect(res.status).not.toBe(503);
    expect(res.status).toBe(401);
  });
});

// D1 Sessions API wiring, asserted at the edge rather than in isolation. The
// unit tests in `db/d1-session.test.ts` prove the shim routes to whatever
// session is on the async context; these prove the Worker actually PUTS one
// there, on both entry points, and that no query escapes to the raw binding.
// That is the failure that would be invisible otherwise: everything keeps
// working, replication is simply never used.
describe("D1 session routing at the entry points", () => {
  /**
   * A D1 binding that records what it was asked for, delegating to the real
   * Miniflare database so the request under test still gets real answers.
   * Every probe is a fresh object, which also forces `index.ts` to rebuild its
   * isolate-cached app (the cache is keyed on binding identity).
   */
  function probeD1() {
    const constraints: string[] = [];
    const sessionQueries: string[][] = [];
    const bindingQueries: string[] = [];

    const binding = {
      // Reaching these two means a query bypassed the session entirely.
      prepare: (query: string) => {
        bindingQueries.push(query);
        return DB.prepare(query);
      },
      batch: (statements: D1PreparedStatement[]) => {
        bindingQueries.push(`batch:${statements.length}`);
        return DB.batch(statements);
      },
      withSession: (constraint: string) => {
        constraints.push(constraint);
        const queries: string[] = [];
        sessionQueries.push(queries);
        const session = DB.withSession(constraint);
        return {
          prepare: (query: string) => {
            queries.push(query);
            // Drizzle parameterises every value, so the SQL text alone cannot
            // say WHICH request a query belonged to. Record the bound
            // parameters too — that is what the concurrency test reads.
            const statement = session.prepare(query);
            return new Proxy(statement as object, {
              get(target, prop, receiver) {
                if (prop === "bind") {
                  return (...args: unknown[]) => {
                    queries.push(`bind:${args.join(",")}`);
                    return (target as D1PreparedStatement).bind(...args);
                  };
                }
                const value = Reflect.get(target, prop, receiver) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
              },
            }) as D1PreparedStatement;
          },
          batch: (statements: D1PreparedStatement[]) => {
            queries.push(`batch:${statements.length}`);
            return session.batch(statements);
          },
          getBookmark: () => session.getBookmark(),
        };
      },
    } as unknown as D1Database;

    return { binding, constraints, sessionQueries, bindingQueries };
  }

  // Unauthenticated, and it reads D1 — an unknown slug still costs the lookup
  // that answers 404, which is all this needs. The organiser routes the rest of
  // this file uses would 401 before touching the database.
  const inviteRequest = (slug = "no-such-slug"): Parameters<NonNullable<typeof handler.fetch>>[0] =>
    new Request(`https://api.example.com/api/invite/${slug}`) as unknown as Parameters<
      NonNullable<typeof handler.fetch>
    >[0];

  it("opens one first-primary session per request and routes every query to it", async () => {
    const probe = probeD1();
    const env = { ...BASE_ENV, DB: probe.binding } as unknown as Parameters<
      NonNullable<typeof handler.fetch>
    >[1];

    const res = await handler.fetch!(inviteRequest(), env, ctx);

    expect(res.status).toBe(404);
    expect(probe.constraints).toEqual([D1_SESSION_CONSTRAINT]);
    expect(probe.sessionQueries[0]?.length ?? 0).toBeGreaterThan(0);
    // The one that matters: a Drizzle handle built over the raw binding would
    // opt every query out of replication with nothing to notice.
    expect(probe.bindingQueries).toEqual([]);
  });

  it("gives each request its own session", async () => {
    // Two requests through the SAME isolate-cached app — the app graph and its
    // Drizzle handle are shared, so the session is the only per-request thing.
    const probe = probeD1();
    const env = { ...BASE_ENV, DB: probe.binding } as unknown as Parameters<
      NonNullable<typeof handler.fetch>
    >[1];

    await handler.fetch!(inviteRequest(), env, ctx);
    await handler.fetch!(inviteRequest(), env, ctx);

    expect(probe.constraints).toEqual([D1_SESSION_CONSTRAINT, D1_SESSION_CONSTRAINT]);
    expect(probe.sessionQueries).toHaveLength(2);
    expect(probe.sessionQueries[0]?.length ?? 0).toBeGreaterThan(0);
    expect(probe.sessionQueries[1]?.length ?? 0).toBeGreaterThan(0);
    expect(probe.bindingQueries).toEqual([]);
  });

  it("keeps two concurrent requests on their own sessions", async () => {
    // The hazard the whole design turns on, asserted against the real thing:
    // the shared `ManagedRuntime` behind `runCire`, the shared app graph, the
    // shared Drizzle handle, two requests in flight at once. If the async
    // context could cross, one request's read could be served by a replica
    // pinned to the other's older bookmark — a stale answer, with nothing
    // failing. Each session must see its own slug and only its own.
    const probe = probeD1();
    const env = { ...BASE_ENV, DB: probe.binding } as unknown as Parameters<
      NonNullable<typeof handler.fetch>
    >[1];

    await Promise.all([
      handler.fetch!(inviteRequest("slug-alpha"), env, ctx),
      handler.fetch!(inviteRequest("slug-beta"), env, ctx),
    ]);

    expect(probe.constraints).toHaveLength(2);
    const bound = probe.sessionQueries.map((queries) =>
      queries.filter((entry) => entry.startsWith("bind:")).join("|"),
    );
    expect(bound.filter((entry) => entry.includes("slug-alpha"))).toHaveLength(1);
    expect(bound.filter((entry) => entry.includes("slug-beta"))).toHaveLength(1);
    expect(bound.some((entry) => entry.includes("slug-alpha") && entry.includes("slug-beta"))).toBe(
      false,
    );
    expect(probe.bindingQueries).toEqual([]);
  });

  it("gives each scheduled sweep its own session", async () => {
    // Six sweeps, six sessions — deliberately NOT one shared by all of them.
    // Sharing would couple six unrelated delete-heavy sweeps to a single
    // bookmark each of them keeps advancing, so every read would be forwarded
    // to the primary regardless.
    const probe = probeD1();
    const env = { ...BASE_ENV, DB: probe.binding } as unknown as Parameters<
      NonNullable<typeof handler.scheduled>
    >[1];

    const pending: Promise<unknown>[] = [];
    const cronCtx = {
      ...ctx,
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    } as unknown as ExecutionContext;

    await handler.scheduled!(
      { cron: "0 4 * * *", scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController,
      env,
      cronCtx,
    );
    // `allSettled`: a sweep failing on this bare schema is not what is under
    // test — that its queries rode a session of its own is.
    await Promise.allSettled(pending);

    expect(pending).toHaveLength(6);
    expect(probe.constraints).toEqual(Array.from({ length: 6 }, () => D1_SESSION_CONSTRAINT));
    expect(probe.bindingQueries).toEqual([]);
  });
});
