import { beforeAll, describe, expect, it } from "bun:test";

import { realtimeSubscribeBudget, weddingHosts, weddings } from "@cire/db";
import { hashToken } from "@shared/crypto/tokens";
import { createRateLimiter } from "@shared/rate-limit";
import type { HubNamespace } from "@shared/realtime/server";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Elysia } from "elysia";

import type { AppOptions } from "../../src/app";
import { DbService } from "../../src/db";
import type { Db } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { weddingRunSheet } from "../../src/middleware/wedding-run-sheet";
import { createRealtimeRoute, WEDDING_TOPIC_ID } from "../../src/routes/realtime";
import type { AssignableHostRole } from "../../src/services/hosts";
import { organiserSessionService } from "../../src/services/organiser-session";
import { appRequest } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { counterValue } from "../test-helpers/metrics-harness";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth, type OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding } from "../test-helpers/wedding";

const WEDDING_ID = "wed_live";
const OWNER = "usr_owner";
const PORTAL = "https://host.example.test";
const CLIENT_IP = "203.0.113.20";
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

/** A wedding `OWNER` owns, under `id`. */
function addWedding(db: Db, id: string, slug: string) {
  insertWedding(db, { id, slug, displayName: "Live", owners: [OWNER] });
}

function setup(overrides: Partial<AppOptions> = {}) {
  const db = createDb(":memory:");
  addWedding(db, WEDDING_ID, "live");
  const hub = fakeHub();
  const route = createRealtimeRoute(db, {
    osnTestKey: auth.key,
    organiserOrigin: PORTAL,
    realtimeHub: hub.hub,
    // Each case its own: the module defaults count per process.
    realtimeIpLimiter: createRateLimiter({ maxRequests: 1_000, windowMs: 60_000 }),
    realtimeLimiter: createRateLimiter({ maxRequests: 1_000, windowMs: 60_000 }),
    ...overrides,
  });
  return { db, route, hub };
}

function seat(
  db: Db,
  osnProfileId: string,
  role: AssignableHostRole,
  runSheetScope: "own" | "full" = "own",
) {
  db.insert(weddingHosts)
    .values({
      id: `whost_${osnProfileId}`,
      weddingId: WEDDING_ID,
      osnProfileId,
      addedByOsnProfileId: OWNER,
      role,
      runSheetScope,
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
      headers: { "cf-connecting-ip": CLIENT_IP, upgrade: "websocket", origin: PORTAL, ...headers },
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

describe("WEDDING_TOPIC_ID", () => {
  // Pinned on the pattern itself as well as through the route: the shared
  // topic parser caps any id at 64 characters, which is where this one's
  // 60-character tail ends, so a route case alone cannot tell the two apart.
  it.each([
    ["the shape cire mints", `wed_${"0123456789abcdef".repeat(2)}`, true],
    ["a tail exactly at the cap", `wed_${"a".repeat(60)}`, true],
    ["a tail one past the cap", `wed_${"a".repeat(61)}`, false],
    ["the prefix alone", "wed_", false],
  ])("%s", (_label, id, matches) => {
    expect(WEDDING_TOPIC_ID.test(id)).toBe(matches);
  });
});

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

  // A helper reads the run sheet, so their tab listens for the changes that
  // move it. The scope narrows what a re-read returns, never whether they may
  // listen.
  it.each(["own", "full"] as const)("admits a helper whose run sheet is %s", async (scope) => {
    const { db, route, hub } = setup();
    seat(db, "usr_helper", "helper", scope);
    expect(await upgrade(route, await bearer("usr_helper"))).toBe(hub.response);
    expect(hub.upgrades).toEqual([{ name: `cire:wedding:${WEDDING_ID}`, subject: "usr_helper" }]);
  });

  it.each([
    // `mintWeddingId` in src/services/weddings.ts: `wed_` and a UUID's 32 hex.
    ["the shape cire mints", `wed_${crypto.randomUUID().replace(/-/g, "")}`],
    ["an id exactly at the length cap", `wed_${"a".repeat(60)}`],
  ])("admits a wedding id of %s", async (_label, weddingId) => {
    const { db, route, hub } = setup();
    addWedding(db, weddingId, "capped");
    const res = await upgrade(route, await bearer(OWNER), topicPath(`cire:wedding:${weddingId}`));
    expect(res).toBe(hub.response);
    expect(hub.upgrades).toEqual([{ name: `cire:wedding:${weddingId}`, subject: OWNER }]);
  });
});

describe("createRealtimeRoute — refused", () => {
  it("refuses a wedding its owner deleted, as an unknown one", async () => {
    const { db, route, hub } = setup();
    db.update(weddings)
      .set({ deletedAt: new Date(), deletedByOsnProfileId: OWNER })
      .where(eq(weddings.id, WEDDING_ID))
      .run();
    expect((await upgrade(route, await bearer(OWNER))).status).toBe(403);
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

  it("401s a session cookie that names no session", async () => {
    const { route, hub } = setup();
    expect((await upgrade(route, { cookie: "cire_org_session=not-a-session" })).status).toBe(401);
    expect(hub.upgrades).toEqual([]);
  });

  it("401s the cookie of a session that was signed out", async () => {
    const { db, route, hub } = setup();
    const token = await seedOrganiserSession(db, OWNER);
    await Effect.runPromise(
      organiserSessionService.revoke(token).pipe(Effect.provideService(DbService, db)),
    );
    expect((await upgrade(route, { cookie: `cire_org_session=${token}` })).status).toBe(401);
    expect(hub.upgrades).toEqual([]);
  });

  it.each([
    [
      "signed by a key the route does not trust",
      () => makeOsnTestAuth().then((other) => other.sign(OWNER)),
    ],
    ["expired", () => auth.sign(OWNER, { expiresIn: "-120s" })],
    ["from a foreign issuer", () => auth.sign(OWNER, { issuer: "https://elsewhere.example" })],
    ["for another audience", () => auth.sign(OWNER, { audience: "some-other-aud" })],
  ])("401s a Bearer token %s", async (_label, mint) => {
    const { route, hub } = setup();
    expect((await upgrade(route, { authorization: `Bearer ${await mint()}` })).status).toBe(401);
    expect(hub.upgrades).toEqual([]);
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
    ["a wedding id under another entity", "cire:guest:wed_live"],
    ["a wedding id with something before its prefix", "cire:wedding:xwed_live"],
    ["an id that is not a wedding id", "cire:wedding:WED_1"],
    ["a wedding id with nothing after its prefix", "cire:wedding:wed_"],
    ["a wedding id one character past the cap", `cire:wedding:wed_${"a".repeat(61)}`],
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

  it("429s past the per-IP limit before it looks the session up", async () => {
    const { db, route, hub } = setup({
      realtimeIpLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    const token = await seedOrganiserSession(db, OWNER);
    expect((await upgrade(route, { cookie: `cire_org_session=${token}` })).status).toBe(101);
    // The session table is gone: a lookup would fail with 503, so a 429 shows
    // the limit answered first.
    db.$client.exec("DROP TABLE organiser_sessions");
    let limited: Response | undefined;
    const out = await captureLogs(async () => {
      limited = await upgrade(route, { cookie: `cire_org_session=${token}` });
    });
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).toBe("60");
    expect(limited?.headers.get("access-control-allow-origin")).toBeNull();
    expect(out).toContain("ip_rate_limited");
    expect(out).not.toContain(CLIENT_IP);
    // Another address still reaches the session lookup.
    const other = await upgrade(route, {
      "cf-connecting-ip": "203.0.113.21",
      cookie: `cire_org_session=${token}`,
    });
    expect(other.status).toBe(503);
    expect(hub.upgrades).toHaveLength(1);
  });

  it("counts no request from another origin against the per-IP limit", async () => {
    // A page on another site opening sockets from a visitor's browser must not
    // use up the limit the visitor's own portal needs.
    const { route, hub } = setup({
      realtimeIpLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    const headers = await bearer(OWNER);
    for (let i = 0; i < 3; i += 1) {
      const foreign = await upgrade(route, { ...headers, origin: "https://elsewhere.example" });
      expect(foreign.status).toBe(403);
    }
    expect(await upgrade(route, headers)).toBe(hub.response);
  });

  it("429s a request with no resolvable client address", async () => {
    const { route, hub } = setup();
    const res = await upgrade(route, { ...(await bearer(OWNER)), "cf-connecting-ip": "" });
    expect(res.status).toBe(429);
    expect(hub.upgrades).toEqual([]);
  });

  it("429s an organiser past the daily ceiling, keyed per organiser, before membership", async () => {
    const { db, route, hub } = setup({ realtimeSubscribesPerDay: 1 });
    seat(db, "usr_cohost", "editor");
    expect((await upgrade(route, await bearer(OWNER))).status).toBe(101);
    const spent = await upgrade(route, await bearer(OWNER));
    expect(spent.status).toBe(429);
    expect(spent.headers.get("retry-after")).toBeNull();
    expect((await upgrade(route, await bearer("usr_cohost"))).status).toBe(101);
    // A stranger spends their own budget, so a refused membership still counts.
    expect((await upgrade(route, await bearer("usr_stranger"))).status).toBe(403);
    expect((await upgrade(route, await bearer("usr_stranger"))).status).toBe(429);
    expect(hub.upgrades.map((u) => u.subject)).toEqual([OWNER, "usr_cohost"]);
    expect(db.select().from(realtimeSubscribeBudget).all()).toHaveLength(3);
  });

  it("429s a helper past the daily ceiling, as any organiser", async () => {
    const { db, route, hub } = setup({ realtimeSubscribesPerDay: 1 });
    seat(db, "usr_helper", "helper");
    expect((await upgrade(route, await bearer("usr_helper"))).status).toBe(101);
    expect((await upgrade(route, await bearer("usr_helper"))).status).toBe(429);
    expect(hub.upgrades.map((u) => u.subject)).toEqual(["usr_helper"]);
  });

  it("503s when no hub is bound", async () => {
    const { route } = setup({ realtimeHub: undefined });
    expect((await upgrade(route, await bearer(OWNER))).status).toBe(503);
  });
});

/**
 * Make every statement that names `table`, and opens with `verb` when one is
 * given, fail when it runs, with a driver error that names the bound params,
 * as a D1 bind error can; drizzle wraps it in a `DrizzleQueryError`, as it
 * does on D1. A dropped table fails before any value is bound, so it could not
 * show what a failed lookup would put in the log. Drizzle's bun:sqlite session
 * gets each statement through `client.query`, so that is what is shadowed.
 */
function failLikeD1(db: ReturnType<typeof createDb>, table: string, verb = "") {
  const client = db.$client;
  const prepare = client.prepare.bind(client);
  Object.defineProperty(client, "query", {
    configurable: true,
    value: (sql: string) => {
      const statement = prepare(sql);
      if (!sql.startsWith(verb) || !sql.includes(`"${table}"`)) return statement;
      const fail = (...params: unknown[]) => {
        throw new Error(`D1_ERROR: ${sql}\nparams: ${params.join(", ")}`);
      };
      return new Proxy(statement, {
        get: (target, key) =>
          key === "all" || key === "values" || key === "get" || key === "run"
            ? fail
            : Reflect.get(target, key),
      });
    },
  });
}

describe("createRealtimeRoute — admits exactly whom the run-sheet gate admits", () => {
  /** The run sheet's own gate, behind a stand-in for osnAuth(). */
  const runSheetGate = (db: Db, profileId: string) =>
    new Elysia({ aot: false })
      .resolve(() => ({ osnProfileId: profileId }))
      .group("/weddings/:weddingId", (group) =>
        group.use(weddingRunSheet(db)).get("/probe", () => ({ ok: true })),
      );

  // Every value the column can hold, the legacy default and a corrupted one
  // included, and no seat at all. A stored value outside the enum degrades to
  // the lowest role, which both gates must then agree on.
  it.each([
    ["owner", "owner"],
    ["editor", "editor"],
    ["viewer", "viewer"],
    ["helper", "helper"],
    ["the legacy default `host`", "host"],
    ["a value outside the enum", "superuser"],
    ["no seat", null],
  ] as const)("%s", async (_label, stored) => {
    const { db, route, hub } = setup();
    const who = "usr_probe";
    if (stored) seat(db, who, stored as AssignableHostRole);
    const gate = await appRequest(runSheetGate(db, who), `/weddings/${WEDDING_ID}/probe`);
    const res = await upgrade(route, await bearer(who));
    expect(res === hub.response).toBe(gate.status === 200);
    expect(res === hub.response ? 101 : res.status).toBe(gate.status === 200 ? 101 : 403);
  });
});

describe("createRealtimeRoute — a lookup that fails", () => {
  it("503s when the membership lookup fails, and logs no profile id", async () => {
    const { db, route, hub } = setup();
    seat(db, "usr_cohost", "editor");
    const headers = await bearer("usr_cohost");
    failLikeD1(db, "wedding_hosts");
    let status = 0;
    const out = await captureLogs(async () => {
      status = (await upgrade(route, headers)).status;
    });
    expect(status).toBe(503);
    expect(hub.upgrades).toEqual([]);
    expect(out).toContain("wedding membership lookup failed");
    expect(out).not.toContain("usr_");
  });

  it("503s when the daily budget cannot be read, and logs no profile id", async () => {
    const { db, route, hub } = setup();
    const headers = await bearer(OWNER);
    // The insert binds the profile id; the prune that runs before it binds
    // only the day, so failing the prune would leave nothing to leak.
    failLikeD1(db, "realtime_subscribe_budget", "insert");
    let status = 0;
    const out = await captureLogs(async () => {
      status = (await upgrade(route, headers)).status;
    });
    expect(status).toBe(503);
    expect(hub.upgrades).toEqual([]);
    expect(out).toContain("realtime subscribe budget failed");
    expect(out).not.toContain("usr_");
  });

  it("503s when the session lookup fails, and logs neither the token nor its hash", async () => {
    const { db, route, hub } = setup();
    const token = await seedOrganiserSession(db, OWNER);
    const tokenHash = await Effect.runPromise(hashToken(token));
    failLikeD1(db, "organiser_sessions");
    let status = 0;
    const out = await captureLogs(async () => {
      status = (await upgrade(route, { cookie: `cire_org_session=${token}` })).status;
    });
    expect(status).toBe(503);
    expect(hub.upgrades).toEqual([]);
    expect(out).toContain("organiser lookup failed");
    expect(out).not.toContain(token);
    expect(out).not.toContain(tokenHash);
  });
});
