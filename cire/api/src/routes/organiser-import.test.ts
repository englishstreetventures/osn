import { describe, it, expect } from "bun:test";

import { events, families, guests, imports } from "@cire/db";
import { eq } from "drizzle-orm";

import { createApp } from "../app";
import { createDb, seedBootstrapWedding } from "../db/setup";
import { createR2Stub } from "../services/r2-imports";

const TOKEN = "test-organiser-secret";

const EVENTS_CSV = [
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
  "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,12 Banksia,Bright,,,",
  "Wedding Ceremony,2026-09-20T16:00:00+10:00,2026-09-20T18:00:00+10:00,Australia/Sydney,Garden,,Formal,,,",
].join("\n");

const GUESTS_CSV = [
  "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
  "1,Sharma,Priya,Sharma,yes,yes",
  "2,Wilson,James,Wilson,no,yes",
].join("\n");

function buildApp() {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  const r2 = createR2Stub();
  const app = createApp(db, { r2, organiserToken: TOKEN });
  return { db, r2, app };
}

async function preview(app: ReturnType<typeof buildApp>["app"], body: object, token = TOKEN) {
  return app.request("/api/organiser/import/preview", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Organiser-Token": token,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/organiser/import/preview", () => {
  it("returns 401 without a token", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/organiser/import/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with a wrong token", async () => {
    const { app } = buildApp();
    const res = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV }, "wrong");
    expect(res.status).toBe(401);
  });

  it("returns 200 + plan for a valid upload", async () => {
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

describe("POST /api/organiser/import/apply", () => {
  it("applies a previewed import", async () => {
    const { app, db } = buildApp();
    const res = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });
    const previewBody = (await res.json()) as { importId: string };

    const apply = await app.request("/api/organiser/import/apply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Organiser-Token": TOKEN,
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
    const res = await app.request("/api/organiser/import/apply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Organiser-Token": TOKEN,
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

    const apply = await app.request("/api/organiser/import/apply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Organiser-Token": TOKEN,
      },
      body: JSON.stringify({ importId }),
    });
    expect(apply.status).toBe(409);
  });
});

describe("POST /api/organiser/import/revert", () => {
  it("reverts the latest applied import", async () => {
    const { app, db } = buildApp();

    // Preview + apply v1
    const r1 = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });
    const id1 = ((await r1.json()) as { importId: string }).importId;
    await app.request("/api/organiser/import/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Organiser-Token": TOKEN },
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
      "1,Sharma,Priya,Sharma,yes,yes,yes",
      "2,Wilson,James,Wilson,no,yes,yes",
    ].join("\n");
    const r2 = await preview(app, { eventsCsv: eventsV2, guestsCsv: guestsV2 });
    const id2 = ((await r2.json()) as { importId: string }).importId;
    await app.request("/api/organiser/import/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Organiser-Token": TOKEN },
      body: JSON.stringify({ importId: id2 }),
    });
    db.update(imports)
      .set({ uploadedAt: 2_000, appliedAt: 2_000 })
      .where(eq(imports.id, id2))
      .run();

    expect(db.select().from(events).all()).toHaveLength(3);

    const revert = await app.request("/api/organiser/import/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Organiser-Token": TOKEN },
      body: JSON.stringify({ importId: id2 }),
    });
    expect(revert.status).toBe(200);
    expect(db.select().from(events).all()).toHaveLength(2);
  });
});

describe("GET /api/organiser/import/list", () => {
  it("returns past imports newest-first", async () => {
    const { app } = buildApp();
    const r1 = await preview(app, { eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV });
    const id1 = ((await r1.json()) as { importId: string }).importId;

    const list = await app.request("/api/organiser/import/list", {
      headers: { "X-Organiser-Token": TOKEN },
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
    const page1Res = await app.request("/api/organiser/import/list?limit=2", {
      headers: { "X-Organiser-Token": TOKEN },
    });
    const page1 = (await page1Res.json()) as {
      imports: { id: string; uploadedAt: number }[];
      nextCursor: number | null;
    };
    expect(page1.imports.map((i) => i.id)).toEqual([id3, id2]);
    expect(page1.nextCursor).toBe(2_000);

    // Page 2: cursor=2000, limit=2 → expect [id1] + nextCursor=null.
    const page2Res = await app.request("/api/organiser/import/list?limit=2&cursor=2000", {
      headers: { "X-Organiser-Token": TOKEN },
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
    const tiny = await app.request("/api/organiser/import/list?limit=0", {
      headers: { "X-Organiser-Token": TOKEN },
    });
    const tinyBody = (await tiny.json()) as { imports: unknown[] };
    expect(tinyBody.imports).toHaveLength(1);

    // limit=999 → clamped to 100 (we only have 1 row, so just check it doesn't 500)
    const huge = await app.request("/api/organiser/import/list?limit=999", {
      headers: { "X-Organiser-Token": TOKEN },
    });
    expect(huge.status).toBe(200);
  });
});

describe("POST /api/organiser/import/preview content-length", () => {
  it("returns 413 when Content-Length declares > 1MB", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/organiser/import/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Organiser-Token": TOKEN,
        // Lie about content length — this should be rejected before parse.
        "Content-Length": String(2 * 1024 * 1024),
      },
      body: JSON.stringify({ eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV }),
    });
    expect(res.status).toBe(413);
  });
});
