import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { weddingHosts, weddings } from "@cire/db";
import { Miniflare } from "miniflare";

import { probeRequests, type ProbeRequest } from "../scripts/d1-latency-probe";
import { D1_SESSION_CONSTRAINT } from "../src/db/d1-session";
import { createD1Db } from "../src/db/index";
import { DDL } from "../src/db/setup";
import handler from "../src/index";
import { jsonBody } from "./test-helpers";
import { captureLogs } from "./test-helpers/capture-logs";
import { seedOrganiserSession } from "./test-helpers/organiser-session";

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
// `beforeAll` so the two can never disagree (`loadConfig` throws when
// `process.env` says production and the tier it is handed does not).

let mf: Miniflare;
let DB: D1Database;
let DB_REALTIME: D1Database;
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
  // tier-mismatch guard the moment a case asks for a non-production tier — the
  // guard is right to throw, since on a real Worker both values come from the
  // same wrangler [vars] and can never disagree.
  savedOsnEnv = process.env.OSN_ENV;
  delete process.env.OSN_ENV;
  delete process.env.BOOTSTRAP_OWNER_PROFILE_ID;

  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: "cire-test-index", DB_REALTIME: "cire-test-index-realtime" },
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
  DB_REALTIME = await mf.getD1Database("DB_REALTIME");
  await DB_REALTIME.exec(ddl);
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

  // `scripts/d1-latency-probe.ts` times these two requests against the dev tier
  // and reports the difference as the cost of one D1 query. That only holds if
  // they differ by exactly one query, so this drives the probe's own requests
  // through the Worker and counts. A renamed cookie or a reshaped auth plugin
  // fails here rather than turning the query arm into a second control.
  it("costs the latency probe's control no query and its query arm exactly one", async () => {
    const send = async (request: ProbeRequest) => {
      const probe = probeD1();
      const env = { ...BASE_ENV, DB: probe.binding } as unknown as Parameters<
        NonNullable<typeof handler.fetch>
      >[1];
      const res = await handler.fetch!(
        new Request(request.url, {
          // Cloudflare adds this to every deployed request, and the limiter in
          // front of the route refuses a request without one.
          headers: { ...request.headers, "cf-connecting-ip": "203.0.113.7" },
        }) as unknown as Parameters<NonNullable<typeof handler.fetch>>[0],
        env,
        ctx,
      );
      return { res, probe };
    };
    // Drizzle records the bound values beside each statement; count statements.
    const statements = (queries: string[] | undefined) =>
      (queries ?? []).filter((entry) => !entry.startsWith("bind:"));
    const { control, query } = probeRequests("https://api.example.com", "no-such-session");

    const withoutCookie = await send(control);
    const withCookie = await send(query);

    // Same status and body from both, so nothing but the query tells them apart.
    expect(withoutCookie.res.status).toBe(401);
    expect(withCookie.res.status).toBe(401);
    expect(await jsonBody(withoutCookie.res)).toEqual({ error: "Unauthorized" });
    expect(await jsonBody(withCookie.res)).toEqual({ error: "Unauthorized" });

    expect(withoutCookie.probe.constraints).toEqual([D1_SESSION_CONSTRAINT]);
    expect(statements(withoutCookie.probe.sessionQueries[0])).toEqual([]);

    expect(withCookie.probe.constraints).toEqual([D1_SESSION_CONSTRAINT]);
    const [only, ...rest] = statements(withCookie.probe.sessionQueries[0]);
    expect(rest).toEqual([]);
    expect(only).toMatch(/^select .* from "sessions" where/i);

    expect(withoutCookie.probe.bindingQueries).toEqual([]);
    expect(withCookie.probe.bindingQueries).toEqual([]);
  });

  it("answers a realtime upgrade inside the request's session", async () => {
    // `/realtime/*` runs before the Elysia app, so it is the one entry point
    // this describe's other cases cannot reach. An unknown session cookie
    // still costs the session lookup that answers 401.
    const portal = "https://host.example.com";
    const probe = probeD1();
    const env = {
      ...BASE_ENV,
      DB: probe.binding,
      WEB_ORIGIN: `https://invite.example.com,${portal}`,
      REALTIME_HUB: {
        getByName: () => ({
          fetch: async () => new Response(null, { status: 101 }),
          publish: async () => 0,
        }),
      },
    } as unknown as Parameters<NonNullable<typeof handler.fetch>>[1];

    const res = await handler.fetch!(
      new Request(`https://api.example.com/realtime/${encodeURIComponent("cire:wedding:wed_rt")}`, {
        headers: {
          upgrade: "websocket",
          origin: portal,
          cookie: "cire_org_session=no-such-session",
        },
      }) as Parameters<NonNullable<typeof handler.fetch>>[0],
      env,
      ctx,
    );

    expect(res.status).toBe(401);
    expect(probe.constraints).toEqual([D1_SESSION_CONSTRAINT]);
    const statements = (probe.sessionQueries[0] ?? []).filter(
      (entry) => !entry.startsWith("bind:"),
    );
    expect(
      statements.filter((sql) => /^select .* from "organiser_sessions"/i.test(sql)),
    ).toHaveLength(1);
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

  const HUB_MISSING = "REALTIME_HUB binding missing in a deployed tier";

  it("serves a deployed tier without the hub binding, answering 503 for realtime only", async () => {
    const env = envWith();
    const token = await seedOwner();
    let realtime = new Response();
    const logs = await captureLogs(async () => {
      realtime = await handler.fetch!(
        new Request(`https://api.example.com${TOPIC_PATH}`, {
          headers: { upgrade: "websocket", origin: PORTAL, cookie: `cire_org_session=${token}` },
        }) as Parameters<NonNullable<typeof handler.fetch>>[0],
        env,
        ctx,
      );
    });
    expect(realtime.status).toBe(503);
    // Loud in a deployed tier: the missing binding is logged as an error.
    expect(logs).toMatch(new RegExp(`ERROR \\(#\\d+\\): ${HUB_MISSING}`));
    const list = await handler.fetch!(
      new Request("https://api.example.com/api/organiser/weddings", {
        headers: { cookie: `cire_org_session=${token}` },
      }) as Parameters<NonNullable<typeof handler.fetch>>[0],
      env,
      ctx,
    );
    expect(list.status).toBe(200);
  });

  it("says nothing about a missing hub in the local tier", async () => {
    const env = {
      ...(envWith() as unknown as Record<string, unknown>),
      OSN_ENV: "local",
    } as unknown as Parameters<NonNullable<typeof handler.fetch>>[1];
    const token = await seedOwner();
    let realtime = new Response();
    const logs = await captureLogs(async () => {
      realtime = await handler.fetch!(
        new Request(`https://api.example.com${TOPIC_PATH}`, {
          headers: { upgrade: "websocket", origin: PORTAL, cookie: `cire_org_session=${token}` },
        }) as Parameters<NonNullable<typeof handler.fetch>>[0],
        env,
        ctx,
      );
    });
    expect(realtime.status).toBe(503);
    expect(logs).not.toContain(HUB_MISSING);
  });

  it("hands a co-host write's publish to ctx.waitUntil, so the response never waits on the hub", async () => {
    const token = await seedOwner();
    await createD1Db(DB_REALTIME)
      .insert(weddingHosts)
      .values({
        id: "whost_rt_cohost",
        weddingId: "wed_rt",
        osnProfileId: "usr_rt_cohost",
        addedByOsnProfileId: "usr_rt_owner",
        role: "editor",
        createdAt: new Date(),
      })
      .onConflictDoNothing();

    // A hub whose publish is held until the test lets it go. Run inline, it
    // would hold the response with it.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const published: string[] = [];
    const scheduled: Promise<unknown>[] = [];
    const env = {
      ...BASE_ENV,
      DB: freshBinding(),
      WEB_ORIGIN: `https://invite.example.com,${PORTAL}`,
      REALTIME_HUB: {
        getByName: (name: string) => ({
          fetch: async () => new Response(null, { status: 101 }),
          publish: async () => {
            published.push(name);
            await held;
            return 1;
          },
        }),
      },
    } as unknown as Parameters<NonNullable<typeof handler.fetch>>[1];
    const recordingCtx = {
      ...ctx,
      waitUntil: (promise: Promise<unknown>) => {
        scheduled.push(promise);
      },
    } as ExecutionContext;

    try {
      const response = handler.fetch!(
        new Request("https://api.example.com/api/organiser/weddings/wed_rt/hosts/usr_rt_cohost", {
          method: "DELETE",
          headers: { origin: PORTAL, cookie: `cire_org_session=${token}` },
        }) as Parameters<NonNullable<typeof handler.fetch>>[0],
        env,
        recordingCtx,
      );
      // Well under the publish timeout (2 s), which an inline publish would
      // hold the response for.
      const timedOut = new Promise<"timed out">((resolve) =>
        setTimeout(() => resolve("timed out"), 500),
      );
      const first = await Promise.race([response, timedOut]);

      expect(first).not.toBe("timed out");
      expect((first as Response).status).toBe(200);
      expect(published).toEqual(["cire:wedding:wed_rt"]);
      // The held publish is one of the promises the Worker handed to
      // `waitUntil`, still running after the response went out.
      const states = await Promise.all(
        scheduled.map((promise) =>
          Promise.race([
            promise.then(
              () => "settled",
              () => "settled",
            ),
            new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0)),
          ]),
        ),
      );
      expect(states).toContain("pending");
    } finally {
      release();
      await Promise.allSettled(scheduled);
    }
  });
});
