import { beforeAll, describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, guests, rsvpChanges, weddingHosts, weddings } from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { eq } from "drizzle-orm";

import { createApp } from "../../src/app";
import { createDb, seedDb } from "../../src/db/setup";
import { appRequest, jsonBody } from "../test-helpers";
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
  markSeq: number;
  households: number;
  truncated: boolean;
  items: { familyId: string; familyName: string; kinds: string[]; at: string }[];
  rows: { guestId: string; eventId: string | null }[];
  digest: { available: boolean; enabled: boolean };
};

async function feed(app: App, profileId: string): Promise<Feed> {
  const res = await req(app, "GET", base, profileId);
  expect(res.status).toBe(200);
  return (await res.json()) as Feed;
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
      expect(body.rows).toEqual([{ guestId: ada.id, eventId: eventsData.hindu.id }]);
      expect(body.markSeq).toBeGreaterThan(0);
    }
  });

  it("offers the digest switch to the owner and editors only", async () => {
    const { app } = buildApp();
    expect((await feed(app, OWNER)).digest).toEqual({ available: true, enabled: true });
    expect((await feed(app, EDITOR)).digest).toEqual({ available: true, enabled: true });
    expect((await feed(app, VIEWER)).digest.available).toBe(false);
  });
});

describe("POST /rsvp-changes/seen", () => {
  it("moves the caller's marker and nobody else's, for a viewer too", async () => {
    const { app } = buildApp();
    const { markSeq } = await feed(app, VIEWER);
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
