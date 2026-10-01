import { describe, it, expect, beforeAll } from "bun:test";

import { hostRsvpNotices, weddingHosts } from "@cire/db";
import { makeLogEmailLive } from "@shared/email";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import type { AppOptions } from "../../src/app";
import type { Db } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { setExecutionCtx } from "../../src/lib/execution-ctx";
import { CIRE_METRICS } from "../../src/metrics";
import { MAX_HOSTS_PER_WEDDING } from "../../src/services/hosts";
import type { AssignableHostRole } from "../../src/services/hosts";
import type {
  OsnHandleResolver,
  OsnOrganiserEmailLookup,
  OsnProfileDisplayResolver,
} from "../../src/services/osn-bridge";
import { appRequest, jsonBody, TEST_CF_IP, TEST_ORIGIN } from "../test-helpers";
import { counterValue } from "../test-helpers/metrics-harness";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding } from "../test-helpers/wedding";

const WEDDING_ID = "wed_hosts";
const OWNER = "usr_owner";
const COHOST = "usr_bob"; // profile id the stub resolver returns for "bob"
const STRANGER = "usr_stranger";

let auth: OsnTestAuth;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

/** Resolver stub: maps known handles to profile ids; everything else 404s. */
const HANDLE_TO_PROFILE: Record<string, string> = { bob: COHOST, carol: "usr_carol" };
const stubResolver: OsnHandleResolver = async (handle) => {
  const normalised = (handle.startsWith("@") ? handle.slice(1) : handle).trim().toLowerCase();
  const profileId = HANDLE_TO_PROFILE[normalised];
  return profileId
    ? { ok: true, profileId, handle: normalised }
    : { ok: false, reason: "profile_not_found" };
};

/** Resolver that always throws — stands in for osn-api returning a 5xx. */
const throwingResolver: OsnHandleResolver = async () => {
  throw new Error("osn-api 500");
};

/** Display-resolver stub: maps known profile ids to handle + display name. */
const PROFILE_TO_DISPLAY: Record<string, { handle: string; displayName: string | null }> = {
  [COHOST]: { handle: "bob", displayName: "Bob Jones" },
  usr_carol: { handle: "carol", displayName: null },
  [OWNER]: { handle: "alice_owner", displayName: "Alice Owner" },
};
const stubDisplayResolver: OsnProfileDisplayResolver = async (profileIds) => {
  const map = new Map<string, { handle: string; displayName: string | null }>();
  for (const id of profileIds) {
    const display = PROFILE_TO_DISPLAY[id];
    if (display) map.set(id, display);
  }
  return map;
};

/** Display resolver that fails soft to an empty map (osn-api down / no ARC key). */
const emptyDisplayResolver: OsnProfileDisplayResolver = async () => new Map();

/** Display resolver that throws — stands in for osn-api returning a 5xx. */
const throwingDisplayResolver: OsnProfileDisplayResolver = async () => {
  throw new Error("osn-api 500");
};

/** The wedding, its owner seated a minute back so seats a test adds list after
 *  theirs — `created_at` is stored in seconds. */
function seedWedding(db: Db) {
  const seated = new Date(Date.now() - 60_000);
  insertWedding(db, {
    id: WEDDING_ID,
    slug: "hosts-wedding",
    displayName: "Hosts Wedding",
    createdAt: seated,
    updatedAt: seated,
    owners: [OWNER],
  });
}

/** Row a seat directly, so a test can call as any of the roles a seat may
 *  hold, owner included. Typed off the service rather than listed, so a role the API starts
 *  assigning can be seeded here without the literal being widened by hand. */
function seedHostSeat(
  db: Db,
  osnProfileId: string,
  role: AssignableHostRole,
  createdAt: Date = new Date(),
) {
  db.insert(weddingHosts)
    .values({
      id: `whost_${osnProfileId}`,
      weddingId: WEDDING_ID,
      osnProfileId,
      addedByOsnProfileId: OWNER,
      role,
      createdAt,
    })
    .run();
}

function buildApp(overrides: Partial<AppOptions> = {}) {
  const db = createDb(":memory:");
  seedWedding(db);
  const app = createApp(db, {
    osnTestKey: auth.key,
    resolveOsnProfileByHandle: stubResolver,
    // A fresh limiter per app: the module-level default is shared
    // process-wide, so the calls in this file would otherwise 429 whichever
    // test ran last. The limiter's own test passes a tight one.
    hostLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
    ...overrides,
  });
  return { db, app };
}

async function req(
  app: ReturnType<typeof buildApp>["app"],
  method: string,
  path: string,
  profileId?: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return appRequest(app, path, init);
}

const hostsPath = `/api/organiser/weddings/${WEDDING_ID}/hosts`;

describe("POST /api/organiser/weddings/:weddingId/hosts (add by handle)", () => {
  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    const res = await req(app, "POST", hostsPath, undefined, { handle: "bob" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-owner (stranger)", async () => {
    const { app } = buildApp();
    const res = await req(app, "POST", hostsPath, STRANGER, { handle: "bob" });
    expect(res.status).toBe(403);
  });

  it("refuses an editor at every role with 403 forbidden, before resolving the handle", async () => {
    // Host management is owner-only: an editor seats no one, at any role.
    let resolved = 0;
    const { db, app } = buildApp({
      resolveOsnProfileByHandle: async (handle) => {
        resolved += 1;
        return stubResolver(handle);
      },
    });
    seedHostSeat(db, COHOST, "editor");
    for (const role of ["owner", "editor", "viewer", "helper"]) {
      const res = await req(app, "POST", hostsPath, COHOST, { handle: "carol", role });
      expect(res.status, role).toBe(403);
      expect(await jsonBody(res)).toEqual({ error: "forbidden" });
    }
    expect(resolved).toBe(0);
    const rows = db
      .select()
      .from(weddingHosts)
      .where(eq(weddingHosts.osnProfileId, "usr_carol"))
      .all();
    expect(rows).toEqual([]);
  });

  it("credits the owner who added the seat, a second owner included", async () => {
    const { db, app } = buildApp();
    seedHostSeat(db, COHOST, "owner");

    const res = await req(app, "POST", hostsPath, COHOST, { handle: "carol" });
    expect(res.status).toBe(201);
    const [row] = db
      .select({ addedBy: weddingHosts.addedByOsnProfileId, role: weddingHosts.role })
      .from(weddingHosts)
      .where(eq(weddingHosts.osnProfileId, "usr_carol"))
      .all();
    expect(row).toEqual({ addedBy: COHOST, role: "viewer" });
  });

  it("refuses re-adding an OWNER at a lower role (409 already_host)", async () => {
    // An owner holds a seat like everyone else, so the unique seat index is
    // what stops a second owner seating the first again as a viewer — after
    // which removing "that viewer" would appear to strip an owner.
    const { db, app } = buildApp({
      // A handle that resolves to the wedding's first OWNER.
      resolveOsnProfileByHandle: async () => ({ ok: true, profileId: OWNER, handle: "dave" }),
    });
    seedHostSeat(db, COHOST, "owner");

    const res = await req(app, "POST", hostsPath, COHOST, { handle: "dave" });
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "already_host" });
    const rows = db
      .select({ role: weddingHosts.role })
      .from(weddingHosts)
      .where(eq(weddingHosts.osnProfileId, OWNER))
      .all();
    expect(rows).toEqual([{ role: "owner" }]);
  });

  it("lets an owner invite a second owner through the same add", async () => {
    const { db, app } = buildApp();
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "bob", role: "owner" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { host: { osnProfileId: string; role: string } };
    expect(body.host).toMatchObject({ osnProfileId: COHOST, role: "owner" });
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).all();
    expect(row).toMatchObject({ role: "owner", addedByOsnProfileId: OWNER });

    // The new owner holds the owner surface at once.
    const asNewOwner = await req(app, "PUT", `${hostsPath}/${OWNER}/role`, COHOST, {
      role: "owner",
    });
    expect(asNewOwner.status).toBe(200);
  });

  it("lets a second owner invite a third", async () => {
    const { db, app } = buildApp();
    seedHostSeat(db, COHOST, "owner");
    const res = await req(app, "POST", hostsPath, COHOST, { handle: "carol", role: "owner" });
    expect(res.status).toBe(201);
  });

  it("returns 409 host_cap_reached once the wedding holds MAX_HOSTS_PER_WEDDING seats, owners counted", async () => {
    const { db, app } = buildApp();
    // The creator's seat plus 49 more, a second owner among them.
    seedHostSeat(db, "usr_owner_1", "owner");
    for (let i = 2; i < MAX_HOSTS_PER_WEDDING; i += 1) seedHostSeat(db, `usr_seat_${i}`, "viewer");
    const before = await counterValue(CIRE_METRICS.hostAdded, {
      result: "host_cap_reached",
      role: "owner",
    });
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "bob", role: "owner" });
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "host_cap_reached" });
    expect(
      await counterValue(CIRE_METRICS.hostAdded, { result: "host_cap_reached", role: "owner" }),
    ).toBe(before + 1);
  });

  it("returns 403 forbidden for a VIEWER or a HELPER trying to add a host", async () => {
    const { db, app } = buildApp();
    seedHostSeat(db, COHOST, "viewer");
    seedHostSeat(db, "usr_helper", "helper");
    for (const caller of [COHOST, "usr_helper"]) {
      const res = await req(app, "POST", hostsPath, caller, { handle: "carol" });
      expect(res.status).toBe(403);
      expect(await jsonBody(res)).toEqual({ error: "forbidden" });
    }
  });

  it("returns 404 for an unknown wedding", async () => {
    const { app } = buildApp();
    const res = await req(app, "POST", "/api/organiser/weddings/wed_nope/hosts", OWNER, {
      handle: "bob",
    });
    expect(res.status).toBe(404);
  });

  it("adds a host by handle for the owner and persists it", async () => {
    const { db, app } = buildApp();
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "@Bob" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { host: { osnProfileId: string; handle: string } };
    expect(body.host.osnProfileId).toBe(COHOST);
    expect(body.host.handle).toBe("bob");

    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).all();
    expect(row!.weddingId).toBe(WEDDING_ID);
    expect(row!.addedByOsnProfileId).toBe(OWNER);
  });

  it("returns 404 when the handle resolves to no OSN account", async () => {
    const { app } = buildApp();
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "ghost" });
    expect(res.status).toBe(404);
  });

  it("returns 409 already_host when re-adding the same person", async () => {
    const { app } = buildApp();
    await req(app, "POST", hostsPath, OWNER, { handle: "bob" });
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "bob" });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: "already_host" });
  });

  it("returns 400 for a missing handle", async () => {
    const { app } = buildApp();
    const res = await req(app, "POST", hostsPath, OWNER, {});
    expect(res.status).toBe(400);
  });

  it("defaults a roleless add to viewer (a seat starts at what it may read)", async () => {
    // A body naming no role asks for the least a seat can be given, not the
    // most. The portal raises it afterwards through PUT …/role, where the owner
    // is the only caller and the promotion is a deliberate act.
    const { db, app } = buildApp();
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "bob" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { host: { role: string } };
    expect(body.host.role).toBe("viewer");
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).all();
    expect(row!.role).toBe("viewer");
  });

  it("persists an explicit helper role on add", async () => {
    const { db, app } = buildApp();
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "bob", role: "helper" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { host: { role: string } };
    expect(body.host.role).toBe("helper");
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).all();
    expect(row!.role).toBe("helper");
  });

  it("persists an explicit viewer role on add", async () => {
    const { db, app } = buildApp();
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "bob", role: "viewer" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { host: { role: string } };
    expect(body.host.role).toBe("viewer");
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).all();
    expect(row!.role).toBe("viewer");
  });

  it("rejects an unknown role value with 400 (closed enum — no legacy 'host')", async () => {
    const { app } = buildApp();
    for (const role of ["host", "admin", "OWNER"]) {
      const res = await req(app, "POST", hostsPath, OWNER, { handle: "bob", role });
      expect(res.status).toBe(400);
    }
  });

  it("returns 503 when the ARC bridge is unconfigured (fail closed)", async () => {
    const { app } = buildApp({ resolveOsnProfileByHandle: undefined });
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "bob" });
    expect(res.status).toBe(503);
  });

  it("returns 502 when the resolver throws (osn unavailable)", async () => {
    const { app } = buildApp({ resolveOsnProfileByHandle: throwingResolver });
    const res = await req(app, "POST", hostsPath, OWNER, { handle: "bob" });
    expect(res.status).toBe(502);
  });

  it("429s once the per-IP host limit is exceeded (S-L1)", async () => {
    const { app } = buildApp({
      hostLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    const first = await req(app, "POST", hostsPath, OWNER, { handle: "bob" });
    expect(first.status).toBe(201);
    const second = await req(app, "POST", hostsPath, OWNER, { handle: "carol" });
    expect(second.status).toBe(429);
  });
});

describe("GET /api/organiser/weddings/:weddingId/hosts (list)", () => {
  function seedCohost(db: Db) {
    db.insert(weddingHosts)
      .values({
        id: "whost_bob",
        weddingId: WEDDING_ID,
        osnProfileId: COHOST,
        addedByOsnProfileId: OWNER,
        createdAt: new Date(),
      })
      .run();
  }

  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", hostsPath);
    expect(res.status).toBe(401);
  });

  it("lists every seat for the owner, the owner's own included", async () => {
    const { db, app } = buildApp();
    seedCohost(db);
    const res = await req(app, "GET", hostsPath, OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hosts: { osnProfileId: string; role: string }[];
      total: number;
    };
    expect(body.hosts.map((h) => [h.osnProfileId, h.role])).toEqual([
      [OWNER, "owner"],
      [COHOST, "editor"],
    ]);
    expect(body.total).toBe(2);
    // Owners are seats; there is no separate owner field to fall out of step.
    expect(body).not.toHaveProperty("owner");
  });

  it("lists a second owner as an owner, alongside the first", async () => {
    const { db, app } = buildApp();
    seedHostSeat(db, COHOST, "owner");
    const res = await req(app, "GET", hostsPath, COHOST);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: { osnProfileId: string; role: string }[] };
    expect(body.hosts.filter((h) => h.role === "owner").map((h) => h.osnProfileId)).toEqual([
      OWNER,
      COHOST,
    ]);
  });

  it("carries a helper seat's role through to the panel", async () => {
    // The portal's dropdown renders whatever this says. A helper folded to
    // another role here would show the owner a seat they did not create.
    const { db, app } = buildApp();
    seedHostSeat(db, COHOST, "helper");
    const res = await req(app, "GET", hostsPath, OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: { osnProfileId: string; role: string }[] };
    expect(body.hosts).toContainEqual(
      expect.objectContaining({ osnProfileId: COHOST, role: "helper" }),
    );
  });

  it("lists every seat for a CO-HOST too (member read)", async () => {
    const { db, app } = buildApp();
    seedCohost(db);
    const res = await req(app, "GET", hostsPath, COHOST);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: { osnProfileId: string }[] };
    expect(body.hosts.map((h) => h.osnProfileId)).toEqual([OWNER, COHOST]);
  });

  it("names the owner with their resolved handle, as a seat in the list", async () => {
    // Asserted for a CO-HOST caller — someone who isn't an owner can still see
    // who owns the wedding.
    const { db, app } = buildApp({ resolveOsnProfileDisplays: stubDisplayResolver });
    seedCohost(db);
    const res = await req(app, "GET", hostsPath, COHOST);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hosts: { osnProfileId: string; role: string; handle?: string; displayName?: string }[];
    };
    expect(body.hosts[0]).toMatchObject({
      osnProfileId: OWNER,
      role: "owner",
      handle: "alice_owner",
      displayName: "Alice Owner",
    });
  });

  it("falls back to the owner's profileId when the display resolver can't name them", async () => {
    const { db, app } = buildApp({ resolveOsnProfileDisplays: emptyDisplayResolver });
    seedCohost(db);
    const res = await req(app, "GET", hostsPath, OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: { osnProfileId: string; handle?: string }[] };
    expect(body.hosts[0]!.osnProfileId).toBe(OWNER);
    expect(body.hosts[0]!.handle).toBeUndefined();
  });

  it("returns 403 for a stranger", async () => {
    const { db, app } = buildApp();
    seedCohost(db);
    const res = await req(app, "GET", hostsPath, STRANGER);
    expect(res.status).toBe(403);
  });

  it("carries the resolved handle (+ displayName) when the batch resolver provides it", async () => {
    const { db, app } = buildApp({ resolveOsnProfileDisplays: stubDisplayResolver });
    seedCohost(db);
    const res = await req(app, "GET", hostsPath, OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hosts: { osnProfileId: string; handle?: string; displayName?: string }[];
    };
    expect(body.hosts).toHaveLength(2);
    expect(body.hosts[1]!.osnProfileId).toBe(COHOST);
    expect(body.hosts[1]!.handle).toBe("bob");
    expect(body.hosts[1]!.displayName).toBe("Bob Jones");
  });

  it("falls back to profileId (no handle key) when the resolver returns an empty map", async () => {
    const { db, app } = buildApp({ resolveOsnProfileDisplays: emptyDisplayResolver });
    seedCohost(db);
    const res = await req(app, "GET", hostsPath, OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: { osnProfileId: string; handle?: string }[] };
    expect(body.hosts).toHaveLength(2);
    expect(body.hosts[1]!.osnProfileId).toBe(COHOST);
    expect(body.hosts.every((h) => h.handle === undefined)).toBe(true);
  });

  it("still 200s with profileId when NO display resolver is wired (ARC key absent)", async () => {
    const { db, app } = buildApp({ resolveOsnProfileDisplays: undefined });
    seedCohost(db);
    const res = await req(app, "GET", hostsPath, OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: { osnProfileId: string; handle?: string }[] };
    expect(body.hosts.map((h) => h.osnProfileId)).toEqual([OWNER, COHOST]);
    expect(body.hosts.every((h) => h.handle === undefined)).toBe(true);
  });

  it("still 200s (profileId fallback) when the display resolver throws", async () => {
    const { db, app } = buildApp({ resolveOsnProfileDisplays: throwingDisplayResolver });
    seedCohost(db);
    const res = await req(app, "GET", hostsPath, OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hosts: { osnProfileId: string; handle?: string }[] };
    expect(body.hosts.map((h) => h.osnProfileId)).toEqual([OWNER, COHOST]);
    expect(body.hosts.every((h) => h.handle === undefined)).toBe(true);
  });

  it("omits handle for an unresolved host but keeps it for a resolved one (partial map)", async () => {
    const { db, app } = buildApp({ resolveOsnProfileDisplays: stubDisplayResolver });
    seedCohost(db); // bob → resolvable
    db.insert(weddingHosts)
      .values({
        id: "whost_ghost",
        weddingId: WEDDING_ID,
        osnProfileId: "usr_ghost", // not in PROFILE_TO_DISPLAY
        addedByOsnProfileId: OWNER,
        createdAt: new Date(Date.now() + 1000),
      })
      .run();
    const res = await req(app, "GET", hostsPath, OWNER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hosts: { osnProfileId: string; handle?: string }[];
    };
    const byId = new Map(body.hosts.map((h) => [h.osnProfileId, h.handle]));
    expect(byId.get(COHOST)).toBe("bob");
    expect(byId.get("usr_ghost")).toBeUndefined();
  });
});

describe("DELETE /api/organiser/weddings/:weddingId/hosts/:osnProfileId (remove)", () => {
  function seedCohost(db: Db) {
    db.insert(weddingHosts)
      .values({
        id: "whost_bob",
        weddingId: WEDDING_ID,
        osnProfileId: COHOST,
        addedByOsnProfileId: OWNER,
        createdAt: new Date(),
      })
      .run();
  }

  it("returns 401 without a token", async () => {
    const { db, app } = buildApp();
    seedCohost(db);
    const res = await req(app, "DELETE", `${hostsPath}/${COHOST}`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-owner", async () => {
    const { db, app } = buildApp();
    seedCohost(db);
    const res = await req(app, "DELETE", `${hostsPath}/${COHOST}`, STRANGER);
    expect(res.status).toBe(403);
  });

  it("returns 403 when a co-host tries to remove a host (owner-only)", async () => {
    const { db, app } = buildApp();
    seedCohost(db);
    const res = await req(app, "DELETE", `${hostsPath}/${COHOST}`, COHOST);
    expect(res.status).toBe(403);
    // The row is untouched.
    expect(
      db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).all(),
    ).toHaveLength(1);
  });

  it("removes a host for the owner", async () => {
    const { db, app } = buildApp();
    seedCohost(db);
    const res = await req(app, "DELETE", `${hostsPath}/${COHOST}`, OWNER);
    expect(res.status).toBe(200);
    expect(
      db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).all(),
    ).toEqual([]);
  });

  it("lets an owner remove another owner, or leave while another remains", async () => {
    const { db, app } = buildApp();
    seedHostSeat(db, COHOST, "owner");
    seedHostSeat(db, "usr_carol", "owner");
    expect((await req(app, "DELETE", `${hostsPath}/${COHOST}`, OWNER)).status).toBe(200);
    expect((await req(app, "DELETE", `${hostsPath}/${OWNER}`, OWNER)).status).toBe(200);
    const owners = db
      .select({ id: weddingHosts.osnProfileId })
      .from(weddingHosts)
      .where(eq(weddingHosts.role, "owner"))
      .all();
    expect(owners).toEqual([{ id: "usr_carol" }]);
  });

  it("returns 409 last_owner when the only owner tries to leave, and keeps their seat", async () => {
    const { db, app } = buildApp();
    const attrs = { result: "last_owner", actor: "owner" };
    const before = await counterValue(CIRE_METRICS.hostRemoved, attrs);
    const res = await req(app, "DELETE", `${hostsPath}/${OWNER}`, OWNER);
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "last_owner" });
    expect(await counterValue(CIRE_METRICS.hostRemoved, attrs)).toBe(before + 1);
    expect(
      db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, OWNER)).all(),
    ).toHaveLength(1);
  });

  it("refuses the second of two owners removing each other in turn", async () => {
    const { app } = buildApp();
    // Re-seated via the API so the second owner is a real caller.
    await req(app, "POST", hostsPath, OWNER, { handle: "bob", role: "owner" });
    expect((await req(app, "DELETE", `${hostsPath}/${COHOST}`, OWNER)).status).toBe(200);
    // Bob is no owner now, so the gate refuses him before the guard is asked.
    expect((await req(app, "DELETE", `${hostsPath}/${OWNER}`, COHOST)).status).toBe(403);
    expect((await req(app, "DELETE", `${hostsPath}/${OWNER}`, OWNER)).status).toBe(409);
  });

  it("returns 404 for an unknown wedding", async () => {
    const { app } = buildApp();
    const res = await req(app, "DELETE", `/api/organiser/weddings/wed_nope/hosts/${COHOST}`, OWNER);
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/organiser/weddings/:weddingId/hosts/me (leave)", () => {
  const leavePath = `${hostsPath}/me`;

  // Its own limiter per app: the default host limiter is one per process, and
  // this block's calls would otherwise spend the budget later blocks rely on.
  const build = (overrides: Partial<AppOptions> = {}) =>
    buildApp({
      hostLimiter: createRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
      ...overrides,
    });

  function seedNotice(db: Db, osnProfileId: string) {
    db.insert(hostRsvpNotices)
      .values({ weddingId: WEDDING_ID, osnProfileId, updatedAt: new Date() })
      .run();
  }

  const noticeIds = async (db: Db) =>
    (await db.select({ id: hostRsvpNotices.osnProfileId }).from(hostRsvpNotices).all())
      .map((r) => r.id)
      .toSorted();
  const seatIds = async (db: Db) =>
    (await db.select({ id: weddingHosts.osnProfileId }).from(weddingHosts).all())
      .map((r) => r.id)
      .toSorted();

  it("returns 401 without a token", async () => {
    const { app } = build();
    const res = await req(app, "DELETE", leavePath);
    expect(res.status).toBe(401);
  });

  it("returns 403 for a stranger", async () => {
    const { app } = build();
    const res = await req(app, "DELETE", leavePath, STRANGER);
    expect(res.status).toBe(403);
  });

  it("lets an editor leave: their seat and notice row go, everyone else's stay", async () => {
    const { db, app } = build();
    seedHostSeat(db, COHOST, "editor");
    seedHostSeat(db, "usr_carol", "viewer");
    seedNotice(db, COHOST);
    seedNotice(db, "usr_carol");
    seedNotice(db, OWNER);
    const before = await counterValue("cire.host.removed", { result: "ok", actor: "self" });

    const res = await req(app, "DELETE", leavePath, COHOST);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ left: true });
    expect(await seatIds(db)).toEqual([OWNER, "usr_carol"].toSorted());
    expect(await noticeIds(db)).toEqual([OWNER, "usr_carol"].toSorted());
    expect(await counterValue("cire.host.removed", { result: "ok", actor: "self" })).toBe(
      before + 1,
    );
  });

  it("lets a viewer leave", async () => {
    const { db, app } = build();
    seedHostSeat(db, COHOST, "viewer");
    const res = await req(app, "DELETE", leavePath, COHOST);
    expect(res.status).toBe(200);
    expect(await seatIds(db)).toEqual([OWNER]);
  });

  it("refuses the last owner with 409 last_owner and changes nothing", async () => {
    // Also proves the static `/hosts/me` path wins over the owner-gated
    // `/hosts/:osnProfileId`: had that matched, the refusal would be counted
    // against the removal route rather than self-leave.
    const { db, app } = build();
    seedHostSeat(db, COHOST, "editor");
    seedNotice(db, OWNER);
    seedNotice(db, COHOST);
    const before = await counterValue("cire.host.removed", {
      result: "last_owner",
      actor: "self",
    });

    const res = await req(app, "DELETE", leavePath, OWNER);
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "last_owner" });
    expect(await seatIds(db)).toEqual([COHOST, OWNER].toSorted());
    expect(await noticeIds(db)).toEqual([COHOST, OWNER].toSorted());
    expect(await counterValue("cire.host.removed", { result: "last_owner", actor: "self" })).toBe(
      before + 1,
    );
  });

  it("lets an owner leave while another owner remains", async () => {
    const { db, app } = build();
    seedHostSeat(db, COHOST, "owner");
    seedNotice(db, OWNER);
    seedNotice(db, COHOST);
    const before = await counterValue("cire.host.removed", { result: "ok", actor: "self" });

    const res = await req(app, "DELETE", leavePath, OWNER);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ left: true });
    expect(await seatIds(db)).toEqual([COHOST]);
    expect(await noticeIds(db)).toEqual([COHOST]);
    expect(await counterValue("cire.host.removed", { result: "ok", actor: "self" })).toBe(
      before + 1,
    );
  });

  it("lets a helper leave too — holding a seat is the whole test", async () => {
    const { db, app } = build();
    seedHostSeat(db, COHOST, "helper");
    seedNotice(db, COHOST);
    const res = await req(app, "DELETE", leavePath, COHOST);
    expect(res.status).toBe(200);
    expect(await seatIds(db)).toEqual([OWNER]);
    expect(await noticeIds(db)).toEqual([]);
  });

  it("returns 403 on a second call, once the seat is gone", async () => {
    const { db, app } = build();
    seedHostSeat(db, COHOST, "editor");
    expect((await req(app, "DELETE", leavePath, COHOST)).status).toBe(200);
    expect((await req(app, "DELETE", leavePath, COHOST)).status).toBe(403);
  });

  // The portal reaches this route with the organiser session cookie, so the
  // cookie path has to delete the seat it names, not only the bearer's.
  it("leaves on a session cookie and refuses a dead one", async () => {
    const { db, app } = build();
    seedHostSeat(db, COHOST, "editor");
    seedHostSeat(db, "usr_carol", "viewer");

    const dead = await appRequest(app, leavePath, {
      method: "DELETE",
      headers: { cookie: "cire_org_session=not-a-live-session-token" },
    });
    expect(dead.status).toBe(401);
    expect(await seatIds(db)).toEqual([COHOST, OWNER, "usr_carol"].toSorted());

    const token = await seedOrganiserSession(db, COHOST);
    const ok = await appRequest(app, leavePath, {
      method: "DELETE",
      headers: { cookie: `cire_org_session=${token}` },
    });
    expect(ok.status).toBe(200);
    expect(await seatIds(db)).toEqual([OWNER, "usr_carol"].toSorted());
  });

  it("answers a failed delete with 500 and counts it", async () => {
    const { db, app } = build();
    seedHostSeat(db, COHOST, "editor");
    // The member gate reads only `wedding_hosts`, so dropping the notice table
    // lets the request through the gate and fails the batch inside `remove`.
    db.$client.exec("DROP TABLE host_rsvp_notices");
    const before = await counterValue("cire.host.removed", { result: "error", actor: "self" });

    const res = await req(app, "DELETE", leavePath, COHOST);
    expect(res.status).toBe(500);
    expect(await jsonBody(res)).toEqual({ error: "Could not leave this wedding" });
    expect(await seatIds(db)).toEqual([COHOST, OWNER].toSorted());
    expect(await counterValue("cire.host.removed", { result: "error", actor: "self" })).toBe(
      before + 1,
    );
  });

  it("counts the owner's removal of someone else as actor owner", async () => {
    const { db, app } = build();
    seedHostSeat(db, COHOST, "viewer");
    const before = await counterValue("cire.host.removed", { result: "ok", actor: "owner" });
    expect((await req(app, "DELETE", `${hostsPath}/${COHOST}`, OWNER)).status).toBe(200);
    expect(await counterValue("cire.host.removed", { result: "ok", actor: "owner" })).toBe(
      before + 1,
    );
  });

  it("is rate limited per user with the other host-management writes", async () => {
    const { db, app } = build({
      hostLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    // The owner, because the gate runs before the limiter: a co-host's second
    // call would meet the member gate's 403 once their seat is gone.
    seedHostSeat(db, COHOST, "editor");
    expect((await req(app, "DELETE", leavePath, OWNER)).status).toBe(409);
    expect((await req(app, "DELETE", leavePath, OWNER)).status).toBe(429);
  });

  it("returns 404 for an unknown wedding", async () => {
    const { app } = build();
    const res = await req(app, "DELETE", "/api/organiser/weddings/wed_nope/hosts/me", COHOST);
    expect(res.status).toBe(404);
  });

  it("leaves the owner's remove route working for a profile id that starts with `me`", async () => {
    const { db, app } = build();
    seedHostSeat(db, "meadow", "viewer");
    const res = await req(app, "DELETE", `${hostsPath}/meadow`, OWNER);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ removed: true, osnProfileId: "meadow" });
    expect(await seatIds(db)).toEqual([OWNER]);
  });
});

describe("PUT /api/organiser/weddings/:weddingId/hosts/:osnProfileId/role", () => {
  function seedCohost(db: Db, role?: AssignableHostRole) {
    db.insert(weddingHosts)
      .values({
        id: "whost_bob",
        weddingId: WEDDING_ID,
        osnProfileId: COHOST,
        addedByOsnProfileId: OWNER,
        ...(role ? { role } : {}),
        createdAt: new Date(),
      })
      .run();
  }

  const rolePath = `${hostsPath}/${COHOST}/role`;

  it("returns 401 without a token", async () => {
    const { db, app } = buildApp();
    seedCohost(db, "editor");
    const res = await req(app, "PUT", rolePath, undefined, { role: "viewer" });
    expect(res.status).toBe(401);
  });

  it("returns 403 when a co-host tries to change a role (owner-only)", async () => {
    const { db, app } = buildApp();
    seedCohost(db, "editor");
    const res = await req(app, "PUT", rolePath, COHOST, { role: "viewer" });
    expect(res.status).toBe(403);
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).all();
    expect(row!.role).toBe("editor");
  });

  it("flips editor → viewer for the owner and persists it", async () => {
    const { db, app } = buildApp();
    seedCohost(db, "editor");
    const res = await req(app, "PUT", rolePath, OWNER, { role: "viewer" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { host: { osnProfileId: string; role: string } };
    expect(body.host).toMatchObject({ osnProfileId: COHOST, role: "viewer" });
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).all();
    expect(row!.role).toBe("viewer");
  });

  it("flips viewer → editor for the owner", async () => {
    const { db, app } = buildApp();
    seedCohost(db, "viewer");
    const res = await req(app, "PUT", rolePath, OWNER, { role: "editor" });
    expect(res.status).toBe(200);
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).all();
    expect(row!.role).toBe("editor");
  });

  it("moves a seat down to helper for the owner", async () => {
    const { db, app } = buildApp();
    seedCohost(db, "editor");
    const res = await req(app, "PUT", rolePath, OWNER, { role: "helper" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { host: { osnProfileId: string; role: string } };
    expect(body.host).toMatchObject({ osnProfileId: COHOST, role: "helper" });
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).all();
    expect(row!.role).toBe("helper");
  });

  it("raises a helper back up to editor, leaving the stored run-sheet scope alone", async () => {
    // `run_sheet_scope` means nothing for an editor — `runSheetScopeFor()`
    // answers `full` for one whatever the column says — so a promotion has no
    // business rewriting it, and a later demotion finds it as the host left it.
    const { db, app } = buildApp();
    seedCohost(db, "helper");
    const res = await req(app, "PUT", rolePath, OWNER, { role: "editor" });
    expect(res.status).toBe(200);
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).all();
    expect(row!.role).toBe("editor");
    expect(row!.runSheetScope).toBe("own");
  });

  it("promotes a co-host to owner, after which they hold the owner surface", async () => {
    const { db, app } = buildApp();
    seedCohost(db, "editor");
    const res = await req(app, "PUT", rolePath, OWNER, { role: "owner" });
    expect(res.status).toBe(200);
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).all();
    expect(row!.role).toBe("owner");
    const asNewOwner = await req(app, "DELETE", `${hostsPath}/${OWNER}`, COHOST);
    expect(asNewOwner.status).toBe(200);
  });

  it("promotes a co-host to owner on a full wedding: a role change adds no seat", async () => {
    const { db, app } = buildApp();
    seedCohost(db, "editor");
    for (let i = 2; i < MAX_HOSTS_PER_WEDDING; i += 1) seedHostSeat(db, `usr_seat_${i}`, "viewer");
    const res = await req(app, "PUT", rolePath, OWNER, { role: "owner" });
    expect(res.status).toBe(200);
  });

  it("lets an owner step down while another owner remains", async () => {
    const { db, app } = buildApp();
    seedCohost(db, "owner");
    const res = await req(app, "PUT", `${hostsPath}/${OWNER}/role`, OWNER, { role: "editor" });
    expect(res.status).toBe(200);
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, OWNER)).all();
    expect(row!.role).toBe("editor");
    // Stepped down, so the owner surface is gone.
    expect((await req(app, "PUT", rolePath, OWNER, { role: "viewer" })).status).toBe(403);
  });

  it("returns 409 last_owner when the only owner tries to step down", async () => {
    const { db, app } = buildApp();
    const labels = { result: "last_owner", role: "viewer" };
    const before = await counterValue(CIRE_METRICS.hostRoleChanged, labels);
    const res = await req(app, "PUT", `${hostsPath}/${OWNER}/role`, OWNER, { role: "viewer" });
    expect(res.status).toBe(409);
    expect(await jsonBody(res)).toEqual({ error: "last_owner" });
    expect(await counterValue(CIRE_METRICS.hostRoleChanged, labels)).toBe(before + 1);
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, OWNER)).all();
    expect(row!.role).toBe("owner");
  });

  it("returns 404 host_not_found for a profile that holds no seat", async () => {
    const { app } = buildApp();
    const res = await req(app, "PUT", `${hostsPath}/usr_ghost/role`, OWNER, { role: "viewer" });
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ error: "host_not_found" });
  });

  it("returns 400 for a bad role value", async () => {
    const { db, app } = buildApp();
    seedCohost(db, "editor");
    for (const role of ["host", "admin"]) {
      const res = await req(app, "PUT", rolePath, OWNER, { role });
      expect(res.status).toBe(400);
    }
  });
});

describe("co-host dashboard access (weddingMember)", () => {
  function seedCohostAndGuest(db: Db) {
    const now = new Date();
    db.insert(weddingHosts)
      .values({
        id: "whost_bob",
        weddingId: WEDDING_ID,
        osnProfileId: COHOST,
        addedByOsnProfileId: OWNER,
        createdAt: now,
      })
      .run();
  }

  it("lets a co-host read the wedding's guest dashboard", async () => {
    const { db, app } = buildApp();
    seedCohostAndGuest(db);
    const res = await req(app, "GET", `/api/organiser/weddings/${WEDDING_ID}/guests`, COHOST);
    expect(res.status).toBe(200);
  });

  it("still 403s a stranger on the guest dashboard", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", `/api/organiser/weddings/${WEDDING_ID}/guests`, STRANGER);
    expect(res.status).toBe(403);
  });

  it("lets a co-host read the wedding's events too (weddingMember, not just guests)", async () => {
    const { db, app } = buildApp();
    seedCohostAndGuest(db);
    const res = await req(app, "GET", `/api/organiser/weddings/${WEDDING_ID}/events`, COHOST);
    expect(res.status).toBe(200);
  });

  it("still 403s a stranger on the events dashboard", async () => {
    const { app } = buildApp();
    const res = await req(app, "GET", `/api/organiser/weddings/${WEDDING_ID}/events`, STRANGER);
    expect(res.status).toBe(403);
  });

  it("403s a co-host on the owner-only regenerate-code action", async () => {
    const { db, app } = buildApp();
    seedCohostAndGuest(db);
    const res = await req(
      app,
      "POST",
      `/api/organiser/weddings/${WEDDING_ID}/families/fam_x/regenerate-code`,
      COHOST,
    );
    expect(res.status).toBe(403);
  });

  it("includes a co-hosted wedding in the member's wedding list", async () => {
    const { db, app } = buildApp();
    seedCohostAndGuest(db);
    const res = await req(app, "GET", "/api/organiser/weddings", COHOST);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      weddings: {
        id: string;
        slug: string;
        displayName: string;
        role: string;
        tier: string;
        entitlements: string[];
        guestCap: number;
      }[];
    };
    expect(body.weddings).toEqual([
      // The seed omits `role`, landing on the legacy DDL default 'host'
      // (pre-0031 shape) — readers normalise it to 'editor'.
      {
        id: WEDDING_ID,
        slug: "hosts-wedding",
        displayName: "Hosts Wedding",
        role: "editor",
        tier: "ivory",
        entitlements: [],
        guestCap: 100,
      },
    ]);
  });

  it("tags a viewer seat's wedding role:viewer in the list (the string the portal gates UI on)", async () => {
    const { db, app } = buildApp();
    db.insert(weddingHosts)
      .values({
        id: "whost_list_viewer",
        weddingId: WEDDING_ID,
        osnProfileId: "usr_list_viewer",
        addedByOsnProfileId: OWNER,
        role: "viewer",
        createdAt: new Date(),
      })
      .run();
    const res = await req(app, "GET", "/api/organiser/weddings", "usr_list_viewer");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      weddings: {
        id: string;
        slug: string;
        displayName: string;
        role: string;
        tier: string;
        entitlements: string[];
        guestCap: number;
      }[];
    };
    expect(body.weddings).toEqual([
      {
        id: WEDDING_ID,
        slug: "hosts-wedding",
        displayName: "Hosts Wedding",
        role: "viewer",
        tier: "ivory",
        entitlements: [],
        guestCap: 100,
      },
    ]);
  });
});

describe("owner change notices", () => {
  const SECOND = "usr_second";
  const THIRD = "usr_third";
  const ADDRESSES: Record<string, string> = {
    [OWNER]: "alice@example.test",
    [SECOND]: "second@example.test",
    [THIRD]: "third@example.test",
    [COHOST]: "bob@example.test",
  };
  const lookup: OsnOrganiserEmailLookup = async (ids) => ({
    answered: true,
    emails: new Map(ids.flatMap((id) => (ADDRESSES[id] ? [[id, ADDRESSES[id]] as const] : []))),
  });

  /** An app with three owners and a co-host, whose owner notices land in a
   *  recorder. */
  function noticeApp(overrides: Partial<AppOptions> = {}) {
    const mail = makeLogEmailLive();
    const built = buildApp({
      organiserEmailLookup: lookup,
      resolveOsnProfileDisplays: stubDisplayResolver,
      emailLayer: mail.layer,
      ...overrides,
    });
    // Seated two days back: a seat the actor created in the last day does not
    // mail its holder.
    const longAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    seedHostSeat(built.db, SECOND, "owner", longAgo);
    seedHostSeat(built.db, THIRD, "owner", longAgo);
    seedHostSeat(built.db, COHOST, "editor");
    return { ...built, mail };
  }

  const byAddress = (mail: ReturnType<typeof makeLogEmailLive>) =>
    new Map(mail.recorded().map((m) => [m.to, m]));

  it("mails the removed owner, the remover and every other owner once, naming the remover", async () => {
    const { app, mail } = noticeApp();
    const res = await req(app, "DELETE", `${hostsPath}/${SECOND}`, OWNER);
    expect(res.status).toBe(200);

    const sent = mail.recorded();
    expect(sent.map((m) => m.to).toSorted()).toEqual(
      ["alice@example.test", "second@example.test", "third@example.test"].toSorted(),
    );
    expect(sent.every((m) => m.template === "wedding-owner-change")).toBe(true);
    const to = byAddress(mail);
    expect(to.get("second@example.test")?.text).toContain(
      "Alice Owner (@alice_owner) removed you as an owner of Hosts Wedding.",
    );
    expect(to.get("third@example.test")?.text).toContain(
      "Alice Owner (@alice_owner) removed one of the owners of Hosts Wedding.",
    );
    expect(to.get("alice@example.test")?.text).toContain("You removed");
    // The co-host is not an owner and hears nothing.
    expect(to.has("bob@example.test")).toBe(false);
  });

  it("mails on a demotion, with the new role", async () => {
    const { app, mail } = noticeApp();
    const res = await req(app, "PUT", `${hostsPath}/${SECOND}/role`, OWNER, { role: "viewer" });
    expect(res.status).toBe(200);
    const to = byAddress(mail);
    expect(to.size).toBe(3);
    expect(to.get("second@example.test")?.text).toContain(
      "Alice Owner (@alice_owner) changed your role on Hosts Wedding from owner to viewer.",
    );
  });

  it("mails on a self step-down and on an owner leaving, once per person", async () => {
    const { app, mail } = noticeApp();
    const res = await req(app, "PUT", `${hostsPath}/${OWNER}/role`, OWNER, { role: "editor" });
    expect(res.status).toBe(200);
    let to = byAddress(mail);
    expect(to.size).toBe(3);
    expect(to.get("alice@example.test")?.text).toContain(
      "You stepped down as an owner of Hosts Wedding. You are now an editor.",
    );
    expect(to.get("second@example.test")?.text).toContain(
      "Alice Owner (@alice_owner) stepped down as an owner of Hosts Wedding",
    );

    mail.reset();
    const left = await req(app, "DELETE", `${hostsPath}/me`, SECOND);
    expect(left.status).toBe(200);
    to = byAddress(mail);
    // The leaver and the one owner who remains.
    expect([...to.keys()].toSorted()).toEqual(["second@example.test", "third@example.test"]);
    expect(to.get("second@example.test")?.text).toContain("You left Hosts Wedding.");
  });

  it("sends nothing for a co-host's removal or role change, a no-op, or a refused change", async () => {
    const { app, mail, db } = noticeApp();
    expect(
      (await req(app, "PUT", `${hostsPath}/${COHOST}/role`, OWNER, { role: "viewer" })).status,
    ).toBe(200);
    expect(
      (await req(app, "PUT", `${hostsPath}/${SECOND}/role`, OWNER, { role: "owner" })).status,
    ).toBe(200);
    db.delete(weddingHosts).where(eq(weddingHosts.osnProfileId, COHOST)).run();
    expect((await req(app, "DELETE", `${hostsPath}/${STRANGER}`, OWNER)).status).toBe(200);
    expect(mail.recorded()).toEqual([]);

    // The last owner cannot go, so there is nothing to tell.
    db.delete(weddingHosts).where(eq(weddingHosts.osnProfileId, SECOND)).run();
    db.delete(weddingHosts).where(eq(weddingHosts.osnProfileId, THIRD)).run();
    expect((await req(app, "DELETE", `${hostsPath}/${OWNER}`, OWNER)).status).toBe(409);
    expect(mail.recorded()).toEqual([]);
  });

  it("sends nothing without an address lookup, and the change still lands", async () => {
    const { app, mail } = noticeApp({ organiserEmailLookup: undefined });
    expect((await req(app, "DELETE", `${hostsPath}/${SECOND}`, OWNER)).status).toBe(200);
    expect(mail.recorded()).toEqual([]);
  });

  it("names nobody when osn-api cannot, and a failed lookup never fails the request", async () => {
    const { app, mail } = noticeApp({ resolveOsnProfileDisplays: emptyDisplayResolver });
    expect((await req(app, "DELETE", `${hostsPath}/${SECOND}`, OWNER)).status).toBe(200);
    expect(byAddress(mail).get("second@example.test")?.text).toContain("Another owner removed you");

    const down = noticeApp({
      organiserEmailLookup: async () => {
        throw new Error("osn-api down");
      },
    });
    expect((await req(down.app, "DELETE", `${hostsPath}/${SECOND}`, OWNER)).status).toBe(200);
    expect(down.mail.recorded()).toEqual([]);
  });

  it("sends after the response through the request's waitUntil when it has one", async () => {
    const { app, mail } = noticeApp();
    const request = new Request(`http://localhost${hostsPath}/${SECOND}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${await auth.sign(OWNER)}`,
        "cf-connecting-ip": TEST_CF_IP,
        origin: TEST_ORIGIN,
      },
    });
    const kept: Promise<unknown>[] = [];
    setExecutionCtx(request, { waitUntil: (promise) => kept.push(promise) });
    const res = await app.fetch(request);
    expect(res.status).toBe(200);
    expect(kept).toHaveLength(1);
    await Promise.all(kept);
    expect(mail.recorded()).toHaveLength(3);
  });

  it("names the actor on the portal's session cookie, and a dead cookie sends nothing", async () => {
    const { app, db, mail } = noticeApp();
    const dead = await appRequest(app, `${hostsPath}/${SECOND}`, {
      method: "DELETE",
      headers: { cookie: "cire_org_session=not-a-live-session-token" },
    });
    expect(dead.status).toBe(401);
    expect(mail.recorded()).toEqual([]);

    const token = await seedOrganiserSession(db, OWNER);
    const ok = await appRequest(app, `${hostsPath}/${SECOND}/role`, {
      method: "PUT",
      headers: { cookie: `cire_org_session=${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "editor" }),
    });
    expect(ok.status).toBe(200);
    expect(byAddress(mail).get("second@example.test")?.text).toContain(
      "Alice Owner (@alice_owner) changed your role",
    );
  });

  it("tells the owners, not the person, when someone is made an owner", async () => {
    const { app, mail } = noticeApp();
    expect(
      (await req(app, "PUT", `${hostsPath}/${COHOST}/role`, OWNER, { role: "owner" })).status,
    ).toBe(200);
    let to = byAddress(mail);
    expect([...to.keys()].toSorted()).toEqual(
      ["alice@example.test", "second@example.test", "third@example.test"].toSorted(),
    );
    expect(to.get("second@example.test")?.text).toContain(
      "Alice Owner (@alice_owner) made Bob Jones (@bob) an owner of Hosts Wedding.",
    );

    mail.reset();
    expect(
      (await req(app, "POST", hostsPath, OWNER, { handle: "carol", role: "owner" })).status,
    ).toBe(201);
    to = byAddress(mail);
    expect(to.has("bob@example.test")).toBe(true);
    expect(to.get("alice@example.test")?.text).toContain(
      "You added @carol to Hosts Wedding as an owner.",
    );
  });

  it("does not mail a person the remover seated in the last day; the owners still hear", async () => {
    const { app, db, mail } = noticeApp({
      organiserEmailLookup: async (ids) => ({
        answered: true,
        emails: new Map(
          ids.flatMap((id) => {
            const to = id === "usr_fresh" ? "fresh@example.test" : ADDRESSES[id];
            return to ? [[id, to] as const] : [];
          }),
        ),
      }),
    });
    seedHostSeat(db, "usr_fresh", "owner");
    expect((await req(app, "DELETE", `${hostsPath}/usr_fresh`, OWNER)).status).toBe(200);
    const to = byAddress(mail);
    expect(to.has("fresh@example.test")).toBe(false);
    expect([...to.keys()].toSorted()).toEqual(
      ["alice@example.test", "second@example.test", "third@example.test"].toSorted(),
    );
  });

  it("counts emails, not notices, against the budget, the person affected first", async () => {
    const { app, mail } = noticeApp({
      ownerNoticeEmailsPerDay: 4,
    });
    expect((await req(app, "DELETE", `${hostsPath}/${SECOND}`, OWNER)).status).toBe(200);
    expect(mail.recorded()).toHaveLength(3);
    // One email left: the removed owner gets it, the remover does not.
    expect((await req(app, "DELETE", `${hostsPath}/${THIRD}`, OWNER)).status).toBe(200);
    expect(mail.recorded().map((m) => m.to)).toHaveLength(4);
    expect(mail.recorded().at(-1)?.to).toBe("third@example.test");
  });
});
