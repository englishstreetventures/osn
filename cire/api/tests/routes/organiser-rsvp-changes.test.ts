import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, guests, rsvpChanges, weddingHosts, weddings } from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { eq, sql } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import { appRequest, jsonBody } from "../test-helpers";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_rc_editor";
const VIEWER = "usr_rc_viewer";
const HELPER = "usr_rc_helper";
const STRANGER = "usr_rc_stranger";

const base = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/rsvp-changes`;

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function buildApp() {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  for (const [id, osnProfileId, role] of [
    ["whost_rc_editor", EDITOR, "editor"],
    ["whost_rc_viewer", VIEWER, "viewer"],
    ["whost_rc_helper", HELPER, "helper"],
  ] as const) {
    db.insert(weddingHosts)
      .values({
        id,
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId,
        addedByOsnProfileId: OWNER,
        role,
        createdAt: now,
      })
      .run();
  }
  // STRANGER owns another wedding, so a refusal is also the cross-wedding case.
  db.insert(weddings)
    .values({
      id: "wed_rc_other",
      slug: "rc-other",
      displayName: "Other",
      ownerOsnProfileId: STRANGER,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const ada = db
    .select({ id: guests.id, familyId: guests.familyId })
    .from(guests)
    .where(eq(guests.firstName, "Ada"))
    .all()[0]!;
  db.insert(rsvpChanges)
    .values({
      weddingId: BOOTSTRAP_WEDDING_ID,
      familyId: ada.familyId,
      guestId: ada.id,
      eventId: eventsData.hindu.id,
      kind: "reply_new",
      createdAt: new Date("2026-09-26T08:00:00Z"),
    })
    .run();
  const app = createApp(db, { osnTestKey: auth.key });
  return { db, app, ada };
}
type App = ReturnType<typeof buildApp>["app"];

async function req(
  app: App,
  method: string,
  path: string,
  profileId: string | undefined,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Feed = {
  households: number;
  truncated: boolean;
  items: { familyId: string; familyName: string; kinds: string[]; at: string }[];
  digest: { available: boolean; enabled: boolean };
};

type Rows = {
  markSeq: number;
  rows: { guestId: string; eventId: string | null }[];
};

async function feed(app: App, profileId: string): Promise<Feed> {
  const res = await req(app, "GET", base, profileId);
  expect(res.status).toBe(200);
  return (await res.json()) as Feed;
}

async function tableRows(app: App, profileId: string): Promise<Rows> {
  const res = await req(app, "GET", `${base}/rows`, profileId);
  expect(res.status).toBe(200);
  return (await res.json()) as Rows;
}

describe("GET /rsvp-changes", () => {
  it("401s without a token", async () => {
    const { app } = buildApp();
    expect((await req(app, "GET", base, undefined)).status).toBe(401);
  });

  it("403s a stranger and a helper", async () => {
    const { app } = buildApp();
    expect((await req(app, "GET", base, STRANGER)).status).toBe(403);
    expect((await req(app, "GET", base, HELPER)).status).toBe(403);
  });

  it("serves the unseen changes, uncached, to every role that reads RSVPs", async () => {
    const { app, ada } = buildApp();
    for (const profile of [OWNER, EDITOR, VIEWER]) {
      const res = await req(app, "GET", base, profile);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await jsonBody(res)) as Feed;
      expect(body.households).toBe(1);
      expect(body.truncated).toBe(false);
      expect(body.items).toEqual([
        {
          familyId: ada.familyId,
          familyName: "Testfamily",
          kinds: ["reply_new"],
          at: "2026-09-26T08:00:00.000Z",
        },
      ]);
      // The card is never handed the rows or a marker it could post back.
      expect(Object.keys(body).toSorted()).toEqual(
        ["digest", "households", "items", "truncated"].toSorted(),
      );
    }
  });

  it("offers the digest switch to the owner and editors only", async () => {
    const { app } = buildApp();
    expect((await feed(app, OWNER)).digest).toEqual({ available: true, enabled: true });
    expect((await feed(app, EDITOR)).digest).toEqual({ available: true, enabled: true });
    expect((await feed(app, VIEWER)).digest.available).toBe(false);
  });
});

describe("GET /rsvp-changes/rows", () => {
  it("serves the rows to badge and their marker, uncached, to every role that reads RSVPs", async () => {
    const { app, ada } = buildApp();
    for (const profile of [OWNER, EDITOR, VIEWER]) {
      const res = await req(app, "GET", `${base}/rows`, profile);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await jsonBody(res)) as Rows;
      expect(body.rows).toEqual([{ guestId: ada.id, eventId: eventsData.hindu.id }]);
      expect(body.markSeq).toBeGreaterThan(0);
      expect(Object.keys(body).toSorted()).toEqual(["markSeq", "rows"]);
    }
  });

  it("401s without a token, and 403s a stranger and a helper", async () => {
    const { app } = buildApp();
    expect((await req(app, "GET", `${base}/rows`, undefined)).status).toBe(401);
    expect((await req(app, "GET", `${base}/rows`, STRANGER)).status).toBe(403);
    expect((await req(app, "GET", `${base}/rows`, HELPER)).status).toBe(403);
  });
});

describe("POST /rsvp-changes/seen", () => {
  it("moves the caller's marker and nobody else's, for a viewer too", async () => {
    const { app } = buildApp();
    const { markSeq } = await tableRows(app, VIEWER);
    const res = await req(app, "POST", `${base}/seen`, VIEWER, { seq: markSeq });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ seenSeq: markSeq });
    expect((await feed(app, VIEWER)).households).toBe(0);
    expect((await feed(app, OWNER)).households).toBe(1);
  });

  it("400s a body that is not a whole, non-negative number", async () => {
    const { app } = buildApp();
    for (const body of [{ seq: -1 }, { seq: 1.5 }, { seq: "3" }, {}, "not json"]) {
      expect((await req(app, "POST", `${base}/seen`, OWNER, body)).status).toBe(400);
    }
  });

  it("403s a helper and a stranger", async () => {
    const { app } = buildApp();
    expect((await req(app, "POST", `${base}/seen`, HELPER, { seq: 1 })).status).toBe(403);
    expect((await req(app, "POST", `${base}/seen`, STRANGER, { seq: 1 })).status).toBe(403);
  });
});

describe("PUT /rsvp-changes/digest", () => {
  it("lets an editor turn their own digest off", async () => {
    const { app } = buildApp();
    const res = await req(app, "PUT", `${base}/digest`, EDITOR, { enabled: false });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ enabled: false });
    expect((await feed(app, EDITOR)).digest.enabled).toBe(false);
    expect((await feed(app, OWNER)).digest.enabled).toBe(true);
  });

  it("refuses a viewer as read-only, and a helper or stranger as forbidden", async () => {
    const { app } = buildApp();
    const viewer = await req(app, "PUT", `${base}/digest`, VIEWER, { enabled: false });
    expect(viewer.status).toBe(403);
    expect(await jsonBody(viewer)).toEqual({ error: "read_only_role" });
    expect((await req(app, "PUT", `${base}/digest`, HELPER, { enabled: false })).status).toBe(403);
    expect((await req(app, "PUT", `${base}/digest`, STRANGER, { enabled: false })).status).toBe(
      403,
    );
  });

  it("400s a body without a boolean", async () => {
    const { app } = buildApp();
    for (const body of [{ enabled: "no" }, {}, "nope"]) {
      expect((await req(app, "PUT", `${base}/digest`, OWNER, body)).status).toBe(400);
    }
  });
});

describe("credentials", () => {
  const routes = [
    { method: "GET", path: base, body: undefined },
    { method: "GET", path: `${base}/rows`, body: undefined },
    { method: "POST", path: `${base}/seen`, body: { seq: 1 } },
    { method: "PUT", path: `${base}/digest`, body: { enabled: false } },
  ] as const;

  const send = (
    app: App,
    route: (typeof routes)[number],
    headers: Record<string, string>,
  ): Promise<Response> =>
    appRequest(app, route.path, {
      method: route.method,
      headers: { "Content-Type": "application/json", ...headers },
      body: route.body === undefined ? undefined : JSON.stringify(route.body),
    });

  // The portal reaches every one of these with the organiser session cookie.
  it("admits an organiser session cookie on every route", async () => {
    const { app, db } = buildApp();
    const token = await seedOrganiserSession(db, OWNER);
    for (const route of routes) {
      const res = await send(app, route, { cookie: `cire_org_session=${token}` });
      expect(res.status).toBe(200);
    }
  });

  it("401s no credential, a dead cookie, an expired bearer and a malformed bearer on every route", async () => {
    const { app } = buildApp();
    const expired = await auth.sign(OWNER, { expiresIn: "-120s" });
    for (const route of routes) {
      const credentials: Record<string, string>[] = [
        {},
        { cookie: "cire_org_session=not-a-live-session-token" },
        { authorization: `Bearer ${expired}` },
        { authorization: "Bearer not-a-jwt" },
      ];
      for (const headers of credentials) {
        expect((await send(app, route, headers)).status).toBe(401);
      }
    }
  });

  it("403s a live cookie sent from a foreign origin on the two writes", async () => {
    const { app, db } = buildApp();
    const token = await seedOrganiserSession(db, OWNER);
    for (const route of routes.filter((r) => r.method !== "GET")) {
      const res = await send(app, route, {
        cookie: `cire_org_session=${token}`,
        origin: "https://evil.example",
      });
      expect(res.status).toBe(403);
    }
    expect((await feed(app, OWNER)).digest.enabled).toBe(true);
    expect((await feed(app, OWNER)).households).toBe(1);
  });
});

describe("a failed read or write", () => {
  it("answers 500 with the documented body on every route", async () => {
    const { app, db } = buildApp();
    db.run(sql`DROP TABLE rsvp_changes`);
    for (const [method, path, body] of [
      ["GET", base, undefined],
      ["GET", `${base}/rows`, undefined],
      ["POST", `${base}/seen`, { seq: 1 }],
    ] as const) {
      const res = await req(app, method, path, OWNER, body);
      expect(res.status).toBe(500);
      expect(await jsonBody(res)).toEqual({ error: "Internal error" });
    }
    db.run(sql`DROP TABLE host_rsvp_notices`);
    const put = await req(app, "PUT", `${base}/digest`, OWNER, { enabled: false });
    expect(put.status).toBe(500);
    expect(await jsonBody(put)).toEqual({ error: "Internal error" });
  });
});

describe("POST /rsvp-changes/seen bounds", () => {
  it("takes 0 and the largest safe integer, and refuses one past it", async () => {
    const { app } = buildApp();
    expect((await req(app, "POST", `${base}/seen`, OWNER, { seq: 0 })).status).toBe(200);
    const max = await req(app, "POST", `${base}/seen`, OWNER, { seq: Number.MAX_SAFE_INTEGER });
    expect(max.status).toBe(200);
    // Clamped to the wedding's newest change, not stored as sent.
    expect(((await max.json()) as { seenSeq: number }).seenSeq).toBeLessThan(1000);
    const past = await req(app, "POST", `${base}/seen`, OWNER, {
      seq: Number.MAX_SAFE_INTEGER + 2,
    });
    expect(past.status).toBe(400);
  });
});
