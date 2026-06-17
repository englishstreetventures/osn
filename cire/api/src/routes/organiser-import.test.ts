import { describe, it, expect, beforeAll } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, families, guests, imports, weddings } from "@cire/db";
import { eq } from "drizzle-orm";

import { createApp } from "../app";
import { createDb, seedBootstrapWedding } from "../db/setup";
import { createR2Stub } from "../services/r2-imports";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

// OSN JWT minted for the seeded bootstrap-wedding owner. Required by the
// osnAuth gate on /api/organiser/*; weddingOwner() then proves the caller owns
// the :weddingId in the path and scopes every import operation to it.
let auth: OsnTestAuth;
let bearer: string;

// Every import operation is scoped to an explicit wedding in the URL.
const IMPORT_BASE = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/import`;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
  // Local dev default owner from resolveBootstrapOwnerProfileId (OSN_ENV unset).
  bearer = await auth.sign("usr_dev_bootstrap_owner");
});

const EVENTS_CSV = [
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
  "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,12 Banksia,Bright,,,",
  "Wedding Ceremony,2026-09-20T16:00:00+10:00,2026-09-20T18:00:00+10:00,Australia/Sydney,Garden,,Formal,,,",
].join("\n");

const GUESTS_CSV = [
  "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
  "1,Testfamily,Ada,Testfamily,yes,yes",
  "2,Sampleton,Bo,Sampleton,no,yes",
].join("\n");

function buildApp() {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  const r2 = createR2Stub();
  const app = createApp(db, { r2, osnTestKey: auth.key });
  return { db, r2, app };
}

async function preview(app: ReturnType<typeof buildApp>["app"], body: object) {
  return appRequest(app, `${IMPORT_BASE}/preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/organiser/weddings/:weddingId/import/preview", () => {
  it("returns 401 without an OSN JWT", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${IMPORT_BASE}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 for an authenticated caller who does not own the wedding", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${IMPORT_BASE}/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await auth.sign("usr_not_an_owner")}`,
      },
      body: JSON.stringify({ eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("returns 404 for an unknown wedding in the path", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, "/api/organiser/weddings/wed_nope/import/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "wedding_not_found" });
  });

  it("rejects a non-owner before parsing the body (403, not 400) (T-S1)", async () => {
    const { app } = buildApp();
    // Malformed body — if the gate ran after parse, this would 400. The
    // ownership gate must fire first, so a non-owner gets 403 regardless.
    const res = await appRequest(app, `${IMPORT_BASE}/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await auth.sign("usr_not_an_owner")}`,
      },
      body: "{not json",
    });
    expect(res.status).toBe(403);
  });

  it("returns 200 + plan for a valid upload, scoped to the caller's wedding", async () => {
    const { app, db } = buildApp();
    const res = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      importId: string;
      plan: { eventCreates: unknown[] };
      warnings: string[];
    };
    expect(body.importId).toBeTruthy();
    expect(body.plan.eventCreates).toHaveLength(2);
    const [row] = db.select().from(imports).where(eq(imports.id, body.importId)).all();
    expect(row!.status).toBe("preview");
    // The import lands under the caller's owned wedding (the bearer is the
    // seeded bootstrap-wedding owner), not a hardcoded scope.
    expect(row!.weddingId).toBe(BOOTSTRAP_WEDDING_ID);
  });

  it("returns 422 with cell coords (and NO contents) for formula injection", async () => {
    const { app } = buildApp();
    const evil = [
      "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
      "=cmd|',2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,,,,,,",
    ].join("\n");
    const res = await preview(app, { eventsCsv: evil, guestsCsv: GUESTS_CSV });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.row).toBe(2);
    expect(body.column).toBe(1);
    // Body must NOT carry the offending cell content.
    expect(JSON.stringify(body)).not.toContain("cmd");
    expect(JSON.stringify(body)).not.toContain("=cmd");
  });

  it("returns 422 for a missing required column", async () => {
    const { app } = buildApp();
    const bad = ["Event Name,End,Timezone\nMehndi,x,y"].join("\n");
    const res = await preview(app, { eventsCsv: bad, guestsCsv: GUESTS_CSV });
    expect(res.status).toBe(422);
  });
});

describe("POST /api/organiser/weddings/:weddingId/import/apply", () => {
  it("applies a previewed import", async () => {
    const { app, db } = buildApp();
    const res = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });
    const previewBody = (await res.json()) as { importId: string };

    const apply = await appRequest(app, `${IMPORT_BASE}/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ importId: previewBody.importId }),
    });
    expect(apply.status).toBe(200);

    expect(db.select().from(events).all()).toHaveLength(2);
    expect(db.select().from(families).all()).toHaveLength(2);
    expect(db.select().from(guests).all()).toHaveLength(2);

    const [row] = db.select().from(imports).where(eq(imports.id, previewBody.importId)).all();
    expect(row!.status).toBe("applied");
  });

  it("returns 404 for an unknown importId", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${IMPORT_BASE}/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ importId: "nonexistent" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 if the import is no longer in preview status (TOCTOU defence)", async () => {
    const { app, db } = buildApp();
    const res = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });
    const { importId } = (await res.json()) as { importId: string };

    // Simulate a concurrent apply by flipping the row to applied first.
    db.update(imports).set({ status: "applied" }).where(eq(imports.id, importId)).run();

    const apply = await appRequest(app, `${IMPORT_BASE}/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ importId }),
    });
    expect(apply.status).toBe(409);
  });
});

describe("POST /api/organiser/weddings/:weddingId/import/revert", () => {
  it("reverts the latest applied import", async () => {
    const { app, db } = buildApp();

    // Preview + apply v1
    const r1 = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });
    const id1 = ((await r1.json()) as { importId: string }).importId;
    await appRequest(app, `${IMPORT_BASE}/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ importId: id1 }),
    });
    // Force separate uploadedAt so revert can sort.
    db.update(imports)
      .set({ uploadedAt: 1_000, appliedAt: 1_000 })
      .where(eq(imports.id, id1))
      .run();

    // Preview + apply v2 (adds a third event)
    const eventsV2 = [
      EVENTS_CSV,
      "Reception,2026-09-20T19:00:00+10:00,2026-09-21T00:00:00+10:00,Australia/Sydney,Doltone,,,,,",
    ].join("\n");
    const guestsV2 = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony,Reception",
      "1,Testfamily,Ada,Testfamily,yes,yes,yes",
      "2,Sampleton,Bo,Sampleton,no,yes,yes",
    ].join("\n");
    const r2 = await preview(app, { eventsCsv: eventsV2, guestsCsv: guestsV2 });
    const id2 = ((await r2.json()) as { importId: string }).importId;
    await appRequest(app, `${IMPORT_BASE}/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ importId: id2 }),
    });
    db.update(imports)
      .set({ uploadedAt: 2_000, appliedAt: 2_000 })
      .where(eq(imports.id, id2))
      .run();

    expect(db.select().from(events).all()).toHaveLength(3);

    const revert = await appRequest(app, `${IMPORT_BASE}/revert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ importId: id2 }),
    });
    expect(revert.status).toBe(200);
    expect(db.select().from(events).all()).toHaveLength(2);
  });
});

describe("GET /api/organiser/weddings/:weddingId/import/list", () => {
  it("returns past imports newest-first", async () => {
    const { app } = buildApp();
    const r1 = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });
    const id1 = ((await r1.json()) as { importId: string }).importId;

    const list = await appRequest(app, `${IMPORT_BASE}/list`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { imports: { id: string }[]; nextCursor: number | null };
    expect(body.imports.find((i) => i.id === id1)).toBeDefined();
    expect(body.nextCursor).toBeNull();
  });

  it("paginates by `?limit` and `?cursor` (uploadedAt-based)", async () => {
    const { app, db } = buildApp();
    // Seed 3 imports with deterministic uploadedAt so we can predict order.
    const r1 = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });
    const id1 = ((await r1.json()) as { importId: string }).importId;
    db.update(imports).set({ uploadedAt: 1_000 }).where(eq(imports.id, id1)).run();

    const r2 = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });
    const id2 = ((await r2.json()) as { importId: string }).importId;
    db.update(imports).set({ uploadedAt: 2_000 }).where(eq(imports.id, id2)).run();

    const r3 = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });
    const id3 = ((await r3.json()) as { importId: string }).importId;
    db.update(imports).set({ uploadedAt: 3_000 }).where(eq(imports.id, id3)).run();

    // Page 1: limit=2 → expect [id3, id2] + nextCursor=2000.
    const page1Res = await appRequest(app, `${IMPORT_BASE}/list?limit=2`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    const page1 = (await page1Res.json()) as {
      imports: { id: string; uploadedAt: number }[];
      nextCursor: number | null;
    };
    expect(page1.imports.map((i) => i.id)).toEqual([id3, id2]);
    expect(page1.nextCursor).toBe(2_000);

    // Page 2: cursor=2000, limit=2 → expect [id1] + nextCursor=null.
    const page2Res = await appRequest(app, `${IMPORT_BASE}/list?limit=2&cursor=2000`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    const page2 = (await page2Res.json()) as {
      imports: { id: string }[];
      nextCursor: number | null;
    };
    expect(page2.imports.map((i) => i.id)).toEqual([id1]);
    expect(page2.nextCursor).toBeNull();
  });

  it("clamps limit to [1, 100]", async () => {
    const { app } = buildApp();
    await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });

    // limit=0 → clamped to 1
    const tiny = await appRequest(app, `${IMPORT_BASE}/list?limit=0`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    const tinyBody = (await tiny.json()) as { imports: unknown[] };
    expect(tinyBody.imports).toHaveLength(1);

    // limit=999 → clamped to 100 (we only have 1 row, so just check it doesn't 500)
    const huge = await appRequest(app, `${IMPORT_BASE}/list?limit=999`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(huge.status).toBe(200);
  });
});

describe("wedding scoping: import is tenant-isolated", () => {
  // A SECOND wedding owned by someone else, pre-populated with its own event,
  // family and guest. The import calls here all target the bootstrap wedding's
  // path (`IMPORT_BASE`), gated by weddingOwner() — the second tenant's rows
  // must be invisible to the diff and untouched by apply.
  const OTHER_EVENT = "evt_second_party";
  const OTHER_FAMILY = "fam_second";
  const OTHER_GUEST = "gst_second";

  function addSecondWedding(db: ReturnType<typeof buildApp>["db"]) {
    const now = new Date();
    db.insert(weddings)
      .values({
        id: "wed_second",
        slug: "second-wedding",
        displayName: "Second Wedding",
        ownerOsnProfileId: "usr_someone_else",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(events)
      .values({
        id: OTHER_EVENT,
        weddingId: "wed_second",
        slug: "second-party",
        name: "Second Party",
        date: "2027-02-02",
        location: "Elsewhere",
        description: "",
        startAt: "2027-02-02T10:00:00+11:00",
        endAt: "2027-02-02T12:00:00+11:00",
        timezone: "Australia/Sydney",
        address: null,
        dressCodeDescription: null,
        dressCodePalette: null,
        pinterestUrl: null,
        mapsUrl: null,
        sortOrder: 0,
      })
      .run();
    db.insert(families)
      .values({
        id: OTHER_FAMILY,
        weddingId: "wed_second",
        publicId: "SECOND-FAM",
        familyName: "Secondfamily",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(guests)
      .values({
        id: OTHER_GUEST,
        familyId: OTHER_FAMILY,
        firstName: "Zoe",
        lastName: "Secondfamily",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  it("previews fine with a single wedding present", async () => {
    const { app } = buildApp();
    const res = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });
    expect(res.status).toBe(200);
  });

  it("previews scoped to the caller's wedding when a second wedding exists", async () => {
    const { app, db } = buildApp();
    addSecondWedding(db);
    const res = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: { eventRemoves: unknown[]; familyRemoves: unknown[]; guestRemoves: unknown[] };
    };
    // The other tenant's rows are out of scope, so nothing is flagged for removal.
    expect(body.plan.eventRemoves).toHaveLength(0);
    expect(body.plan.familyRemoves).toHaveLength(0);
    expect(body.plan.guestRemoves).toHaveLength(0);
  });

  it("apply only touches the caller's wedding, leaving the other tenant intact", async () => {
    const { app, db } = buildApp();
    addSecondWedding(db);

    const res = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });
    const { importId } = (await res.json()) as { importId: string };

    const apply = await appRequest(app, `${IMPORT_BASE}/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ importId }),
    });
    expect(apply.status).toBe(200);

    // Bootstrap wedding got its import; the second tenant's rows survived.
    expect(
      db.select().from(events).where(eq(events.weddingId, BOOTSTRAP_WEDDING_ID)).all(),
    ).toHaveLength(2);
    expect(db.select().from(events).where(eq(events.id, OTHER_EVENT)).all()).toHaveLength(1);
    expect(db.select().from(families).where(eq(families.id, OTHER_FAMILY)).all()).toHaveLength(1);
    expect(db.select().from(guests).where(eq(guests.id, OTHER_GUEST)).all()).toHaveLength(1);
  });
});

describe("POST /api/organiser/weddings/:weddingId/import/preview content-length", () => {
  it("returns 413 when Content-Length declares > 1MB", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${IMPORT_BASE}/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        // Lie about content length — this should be rejected before parse.
        "Content-Length": String(2 * 1024 * 1024),
      },
      body: JSON.stringify({ eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV }),
    });
    expect(res.status).toBe(413);
  });
});
