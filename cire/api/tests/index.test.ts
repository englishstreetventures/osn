import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { exportKeyToJwk, generateArcKeyPair } from "@shared/crypto/jwk";
import { Miniflare } from "miniflare";

import { probeRequests, type ProbeRequest } from "../scripts/d1-latency-probe";
import { D1_SESSION_CONSTRAINT } from "../src/db/d1-session";
import { DDL } from "../src/db/setup";
import handler from "../src/index";
import { jsonBody } from "./test-helpers";
import { captureLogs } from "./test-helpers/capture-logs";

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
describe("WEB_ORIGIN boot check", () => {
  const fetchWith = (env: Record<string, unknown>) =>
    handler.fetch!(
      new Request("https://api.example.com/api/organiser/weddings"),
      { ...BASE_ENV, DB, ...env } as unknown as Parameters<NonNullable<typeof handler.fetch>>[1],
      ctx,
    );

  it("refuses a host that only starts with localhost", async () => {
    const res = await fetchWith({ WEB_ORIGIN: "http://localhost.attacker.example" });
    expect(res.status).toBe(503);
    expect(await jsonBody(res)).toEqual({
      error:
        "Worker misconfigured: WEB_ORIGIN entry 1 must be https:// (http://localhost only outside a deployed tier)",
    });
  });

  it("refuses an entry with a trailing slash, and never echoes userinfo", async () => {
    const slash = await fetchWith({ WEB_ORIGIN: "https://app.example.com/" });
    expect(slash.status).toBe(503);
    const withUser = await fetchWith({
      WEB_ORIGIN: "https://app.example.com,https://user:secret@app.example.com",
    });
    expect(withUser.status).toBe(503);
    const body = JSON.stringify(await jsonBody(withUser));
    expect(body).toContain("WEB_ORIGIN entry 2");
    expect(body).not.toContain("secret");
  });

  it("refuses http://localhost in a deployed tier", async () => {
    const res = await fetchWith({ WEB_ORIGIN: "http://localhost:4321" });
    expect(res.status).toBe(503);
  });

  it("serves with http://localhost in the local tier", async () => {
    const res = await fetchWith({ WEB_ORIGIN: "http://localhost:4321", OSN_ENV: undefined });
    expect(res.status).toBe(401);
  });
});

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
    expect(only).toMatch(/^select .* from "sessions" .*where .*"sessions"."token" = \?/i);

    expect(withoutCookie.probe.bindingQueries).toEqual([]);
    expect(withCookie.probe.bindingQueries).toEqual([]);
  });

  // The per-IP limiter on a guest route must answer before `sessionAuth` looks
  // the cookie up: a refused request costs no D1 query. Each case mounts a
  // refusing binding for the limiter that route reads, and sends an unknown
  // `cire_session` cookie that would otherwise cost one `sessions` lookup. The
  // account-link POST also checks an OSN credential, so it is sent once more
  // with an unknown `cire_org_session` cookie, which would otherwise cost one
  // `organiser_sessions` lookup.
  describe("a refused guest request never reaches the session lookup", () => {
    const refusingLimiter = { limit: async () => ({ success: false }) };
    const GUEST_COOKIE = "cire_session=no-such-session";
    const ORGANISER_COOKIE = "cire_org_session=no-such-organiser-session";
    const cases: {
      name: string;
      method: string;
      path: string;
      binding: string;
      cookie?: string;
    }[] = [
      {
        name: "GET /api/claim/session",
        method: "GET",
        path: "/api/claim/session",
        binding: "CLAIM_SESSION_RATE_LIMITER",
      },
      {
        name: "DELETE /api/account/link/:guestId",
        method: "DELETE",
        path: "/api/account/link/gst_probe",
        binding: "CLAIM_RATE_LIMITER",
      },
      {
        name: "POST /api/account/link",
        method: "POST",
        path: "/api/account/link",
        binding: "CLAIM_RATE_LIMITER",
      },
      {
        name: "POST /api/account/link with an organiser session cookie",
        method: "POST",
        path: "/api/account/link",
        binding: "CLAIM_RATE_LIMITER",
        cookie: `${GUEST_COOKIE}; ${ORGANISER_COOKIE}`,
      },
      {
        name: "POST /api/invite/:slug/registry/items/:itemId/claim",
        method: "POST",
        path: "/api/invite/no-such-slug/registry/items/itm_probe/claim",
        binding: "REGISTRY_GUEST_RATE_LIMITER",
      },
      {
        name: "DELETE /api/invite/:slug/registry/items/:itemId/claim",
        method: "DELETE",
        path: "/api/invite/no-such-slug/registry/items/itm_probe/claim",
        binding: "REGISTRY_GUEST_RATE_LIMITER",
      },
    ];

    const send = async (
      method: string,
      path: string,
      limiters: Record<string, unknown>,
      cookie = GUEST_COOKIE,
    ) => {
      const probe = probeD1();
      const env = { ...BASE_ENV, ...limiters, DB: probe.binding } as unknown as Parameters<
        NonNullable<typeof handler.fetch>
      >[1];
      const res = await handler.fetch!(
        new Request(`https://api.example.com${path}`, {
          method,
          headers: {
            "cf-connecting-ip": "203.0.113.7",
            // The CSRF guard refuses a write without an allowed Origin.
            origin: BASE_ENV.WEB_ORIGIN,
            cookie,
            ...(method === "GET" ? {} : { "content-type": "application/json" }),
          },
          ...(method === "GET" ? {} : { body: "{}" }),
        }) as unknown as Parameters<NonNullable<typeof handler.fetch>>[0],
        env,
        ctx,
      );
      const statements = probe.sessionQueries.flat().filter((entry) => !entry.startsWith("bind:"));
      return { res, statements, probe };
    };

    for (const { name, method, path, binding, cookie } of cases) {
      it(`${name}: 429 with no query`, async () => {
        const { res, statements, probe } = await send(
          method,
          path,
          { [binding]: refusingLimiter },
          cookie,
        );

        expect(res.status).toBe(429);
        expect(statements).toEqual([]);
        expect(probe.bindingQueries).toEqual([]);
      });
    }

    it("the same cookie on an allowed request does cost the lookup", async () => {
      // Control: without it, a cookie the Worker never parsed would pass the
      // cases above too.
      const { res, statements } = await send("DELETE", "/api/account/link/gst_probe", {});

      expect(res.status).toBe(401);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(
        /^select .* from "sessions" .*where .*"sessions"."token" = \?/i,
      );
    });

    it("the organiser cookie on a route that checks it first does cost the lookup", async () => {
      // Control for the organiser cookie: an organiser route with no limiter
      // in front looks it up, so the case above is not passing on a cookie the
      // Worker never read.
      const { res, statements } = await send(
        "GET",
        "/api/organiser/weddings",
        {},
        ORGANISER_COOKIE,
      );

      expect(res.status).toBe(401);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(/^select .* from "organiser_sessions" .*"token" = \?/i);
    });
  });

  const runCron = async (extraEnv: Record<string, unknown> = {}) => {
    const probe = probeD1();
    const env = { ...BASE_ENV, ...extraEnv, DB: probe.binding } as unknown as Parameters<
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
    return { pending, probe };
  };

  // A cron run takes every scheduled sweep through Miniflare's D1 proxy, where
  // each prepare and bind is a blocking round trip to workerd. That is seconds,
  // not milliseconds, on a CI runner busy with the rest of the suite, so every
  // test below that calls `runCron` carries a 30 s budget rather than bun's 5 s
  // default. A timeout here is worse than a failure: bun kills workerd, and the
  // next blocking call waits on it forever, so `bun test` never exits.

  it("gives each scheduled sweep its own session", async () => {
    // One session per sweep — deliberately NOT one shared by all of them.
    // Sharing would couple unrelated delete-heavy sweeps to a single bookmark
    // each of them keeps advancing, so every read would be forwarded to the
    // primary regardless. With no mail transport the digest does not run, so
    // ten sweeps.
    const { pending, probe } = await runCron();
    expect(pending).toHaveLength(10);
    expect(probe.constraints).toEqual(Array.from({ length: 10 }, () => D1_SESSION_CONSTRAINT));
    expect(probe.bindingQueries).toEqual([]);
  }, 30_000);

  it("gives the wedding purge a session of its own", async () => {
    // The purge's candidate reads are the only cron queries that compare
    // `deleted_at` with a cutoff; every statement in that session is the
    // purge's own, on `weddings`, and the two reads go in one batch.
    const { probe } = await runCron();
    const purge = probe.sessionQueries.filter((queries) =>
      queries.some((q) => /deleted_at" <= \?/.test(q)),
    );
    expect(purge).toHaveLength(1);
    expect(purge[0]!.filter((q) => q.startsWith("batch:"))).toEqual(["batch:2"]);
    const statements = purge[0]!.filter((q) => !q.startsWith("bind:") && !q.startsWith("batch:"));
    expect(statements).toHaveLength(2);
    expect(statements.every((q) => q.includes('"weddings"'))).toBe(true);
  }, 30_000);

  it("gives the cire-sheets reconciliation a session of its own: a live sample read first, then one lookup", async () => {
    // The reconciler's reads must open a session of their own, so the first of
    // them reaches the primary: a stale replica could make a live sheet look
    // like an orphan. One live row and one old object in the bucket give it
    // something to judge, so both of its reads run.
    await DB.batch([
      DB.prepare(
        "INSERT INTO weddings (id, slug, display_name, created_at, updated_at) VALUES (?, ?, ?, 0, 0)",
      ).bind("wed_sheets_cron", "sheets-cron", "Sheets Cron"),
      DB.prepare(
        "INSERT INTO imports (id, wedding_id, uploaded_at, format, events_r2_key, guests_r2_key, summary, status) VALUES (?, ?, 0, 'csv', ?, ?, '{}', 'applied')",
      ).bind(
        "imp_cron",
        "wed_sheets_cron",
        "imports/imp_cron/events.csv",
        "imports/imp_cron/guests.csv",
      ),
    ]);
    try {
      const uploaded = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const sheets = {
        list: () =>
          Promise.resolve({
            objects: [{ key: "imports/imp_cron/events.csv", uploaded }],
            truncated: false,
          }),
        delete: () => Promise.resolve(),
        head: (key: string) => Promise.resolve({ key }),
        get: () => Promise.resolve(null),
        put: () => Promise.resolve(),
      };
      const { pending, probe } = await runCron({ SHEETS: sheets });
      expect(pending).toHaveLength(10);
      const reconcile = probe.sessionQueries.filter((queries) =>
        queries.some((q) => q.startsWith("WITH listed(r2_key)")),
      );
      expect(reconcile).toHaveLength(1);
      const statements = reconcile[0]!.filter(
        (q) => !q.startsWith("bind:") && !q.startsWith("batch:"),
      );
      expect(statements).toHaveLength(2);
      expect(statements[0]).toMatch(/^select "events_r2_key" from "imports" limit \?$/);
      expect(statements[1]).toStartWith("WITH listed(r2_key)");
    } finally {
      await DB.prepare("DELETE FROM weddings WHERE id = ?").bind("wed_sheets_cron").run();
    }
  }, 30_000);

  it.each([
    ["a list call fails", { list: () => Promise.reject(new Error("r2 down")) }, "list failed"],
    [
      "its position cannot be read",
      { get: () => Promise.reject(new Error("r2 down")) },
      "position read failed",
    ],
  ])(
    "logs a failed cire-sheets reconciliation and settles the job when %s",
    async (_, broken, reason) => {
      const sheets = {
        list: () => Promise.resolve({ objects: [], truncated: false }),
        delete: () => Promise.resolve(),
        head: () => Promise.resolve(null),
        get: () => Promise.resolve(null),
        put: () => Promise.resolve(),
        ...broken,
      };
      let settled: PromiseSettledResult<unknown>[] = [];
      const logs = await captureLogs(async () => {
        const { pending } = await runCron({ SHEETS: sheets });
        settled = await Promise.allSettled(pending);
      });
      expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
      expect(logs).toContain("scheduled cire-sheets reconciliation failed");
      expect(logs).toContain(reason);
    },
    30_000,
  );

  it("adds the RSVP digest, in a session of its own, only when it has a transport and osn-api", async () => {
    const jwk = await exportKeyToJwk((await generateArcKeyPair()).privateKey);
    const mail = { RESEND_API_KEY: "re_test", OSN_API_URL: "https://osn.example.test" };
    const arc = { CIRE_API_ARC_PRIVATE_KEY: jwk, CIRE_API_ARC_KEY_ID: "kid_test" };

    const full = await runCron({ ...mail, ...arc });
    expect(full.pending).toHaveLength(11);
    expect(full.probe.constraints).toEqual(Array.from({ length: 11 }, () => D1_SESSION_CONSTRAINT));
    expect(full.probe.bindingQueries).toEqual([]);

    // Either half missing: no digest.
    expect((await runCron(mail)).pending).toHaveLength(10);
    expect((await runCron({ ...arc, OSN_API_URL: mail.OSN_API_URL })).pending).toHaveLength(10);
  }, 30_000);

  it("skips the RSVP digest when WEB_ORIGIN fails the boot check", async () => {
    // A cron-only isolate never runs the `fetch` check, and the digest builds
    // its portal links from WEB_ORIGIN.
    const jwk = await exportKeyToJwk((await generateArcKeyPair()).privateKey);
    let result: Awaited<ReturnType<typeof runCron>> | undefined;
    const logs = await captureLogs(async () => {
      result = await runCron({
        RESEND_API_KEY: "re_test",
        OSN_API_URL: "https://osn.example.test",
        CIRE_API_ARC_PRIVATE_KEY: jwk,
        CIRE_API_ARC_KEY_ID: "kid_test",
        WEB_ORIGIN: "http://localhost:4321",
      });
    });
    expect(result?.pending).toHaveLength(10);
    expect(logs).toContain("scheduled rsvp digest skipped: WEB_ORIGIN misconfigured");
  }, 30_000);
});
