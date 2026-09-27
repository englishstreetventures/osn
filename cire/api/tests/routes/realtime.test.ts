import { beforeAll, describe, expect, it } from "bun:test";

import { weddingHosts, weddings } from "@cire/db";
import { hashToken } from "@shared/crypto/tokens";
import { createRateLimiter } from "@shared/rate-limit";
import type { HubNamespace } from "@shared/realtime/server";
import { DrizzleQueryError } from "drizzle-orm";
import { Effect } from "effect";

import type { AppOptions } from "../../src/app";
import type { Db } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { createRealtimeRoute } from "../../src/routes/realtime";
import type { AssignableHostRole } from "../../src/services/hosts";
import { captureLogs } from "../test-helpers/capture-logs";
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

/**
 * Make every statement that names `table` fail as Drizzle's D1 driver does:
 * with a `DrizzleQueryError` whose message ends in the bound params. The
 * bun:sqlite driver throws its own error, which names no params, so a dropped
 * table could not show what a failed D1 lookup would put in the log.
 */
function failLikeD1(db: ReturnType<typeof createDb>, table: string) {
  const client = db.$client;
  const prepare = client.prepare.bind(client);
  client.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes(`"${table}"`)) return statement;
    const fail = (...params: unknown[]) => {
      throw new DrizzleQueryError(sql, params, new Error("D1_ERROR"));
    };
    return new Proxy(statement, {
      get: (target, key) =>
        key === "all" || key === "values" || key === "get" || key === "run"
          ? fail
          : Reflect.get(target, key),
    });
  }) as typeof client.prepare;
}

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
