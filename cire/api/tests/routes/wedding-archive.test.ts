import { beforeAll, describe, expect, it } from "bun:test";

import { events, weddingHosts, weddings } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { EffectDbService, effectDbFor } from "../../src/db/effect-handle";
import { localD1Binding } from "../../src/db/local-d1";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import { MAX_GIFT_EXPORT_ROWS } from "../../src/services/gift-export";
import { createAssetsStub } from "../../src/services/invite-assets";
import type { AssetsBucket } from "../../src/services/invite-assets";
import { MAX_PLANNING_EXPORT_ROWS } from "../../src/services/planning-export";
import { createR2Stub } from "../../src/services/r2-imports";
import { MAX_REGISTRY_EXPORT_ROWS } from "../../src/services/registry-export";
import { MAX_HOUSEHOLD_EXPORT_ROWS } from "../../src/services/roster-export";
import { MAX_SEATING_EXPORT_ROWS } from "../../src/services/seating-export";
import { MAX_QUESTION_EXPORT_ROWS } from "../../src/services/settings-export";
import { MAX_VENDOR_EXPORT_ROWS } from "../../src/services/vendor-export";
import { weddingArchiveService } from "../../src/services/wedding-archive";
import type { ArchiveAssetsSource, ArchiveLimits } from "../../src/services/wedding-archive";
import { appRequest, failStatements, recordStatements, setTier } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import {
  fullWeddingCode,
  fullWeddingKeys,
  fullWeddingStatements,
} from "../test-helpers/full-wedding";
import { counterValue } from "../test-helpers/metrics-harness";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding } from "../test-helpers/wedding";
import { readZip, zipTexts } from "../test-helpers/zip";

/**
 * The whole-wedding archive: who may download it, and what it holds when R2
 * or a limit gets in the way. Each test names its failure mode in
 * `NEW-FEAT.md` (A1–A9, B1–B9). The owner's ordinary download, end to end, is
 * the `cire-seating` E2E flow.
 */

const OWNER = "usr_owner";
const EDITOR = "usr_editor";
const VIEWER = "usr_viewer";
const HELPER = "usr_helper";
const OTHER_OWNER = "usr_other_owner";
const W = "w1";
const FOLDER = `cire-wedding-slug-${W}/`;
const ARCHIVE = `/api/organiser/weddings/${W}/archive`;

/** A JPEG's first bytes, then `n` more: enough for the type sniff. */
const jpeg = (n: number) =>
  new Uint8Array([0xff, 0xd8, 0xff, ...Array.from({ length: n }, () => 7)]);

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

const generous = () => createRateLimiter({ maxRequests: 1_000, windowMs: 60_000 });

function seat(db: TestDb, osnProfileId: string, role: "editor" | "viewer" | "helper") {
  db.insert(weddingHosts)
    .values({
      id: `whost_${osnProfileId}`,
      weddingId: W,
      osnProfileId,
      addedByOsnProfileId: OWNER,
      role,
      createdAt: new Date(),
    })
    .run();
}

/** A wedding with a row in every table, its R2 objects in place, and a seat of each role. */
function seedWedding(opts: { deletedAt?: Date } = {}) {
  const db = createDb(":memory:");
  const now = new Date("2026-10-01T00:00:00Z");
  for (const statement of fullWeddingStatements(W, {
    owner: OWNER,
    deletedAt: opts.deletedAt,
    now,
  })) {
    db.run(statement);
  }
  seat(db, EDITOR, "editor");
  seat(db, VIEWER, "viewer");
  seat(db, HELPER, "helper");
  insertWedding(db, { id: "w2", slug: "w2", displayName: "Another", owners: [OTHER_OWNER] });
  const assets = createAssetsStub();
  for (const key of fullWeddingKeys(W).assets) {
    assets.put(key, jpeg(16), { httpMetadata: { contentType: "image/jpeg" } });
  }
  const sheets = createR2Stub();
  for (const key of fullWeddingKeys(W).sheets) sheets.put(key, `Sheet,${key}\n`);
  return { db, assets, sheets };
}

function buildApp(
  opts: {
    deletedAt?: Date;
    archiveLimiter?: ReturnType<typeof createRateLimiter>;
    exportLimiter?: ReturnType<typeof createRateLimiter>;
  } = {},
) {
  const { db, assets, sheets } = seedWedding(opts);
  const app = createApp(db, {
    osnTestKey: auth.key,
    effectDb: effectDbFor(localD1Binding(db.$client), "fetch"),
    assets,
    r2: sheets,
    archiveLimiter: opts.archiveLimiter ?? generous(),
    exportLimiter: opts.exportLimiter ?? generous(),
  });
  return { db, app };
}

async function post(app: ReturnType<typeof createApp>, profileId?: string, path = ARCHIVE) {
  const headers: Record<string, string> = {};
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, { method: "POST", headers });
}

/** The plan for `W`, read through both database handles as the route reads it. */
function readPlan(db: TestDb) {
  return Effect.runPromise(
    weddingArchiveService
      .read(W, new Date("2026-11-16T00:00:00Z"))
      .pipe(
        Effect.provideService(DbService, db),
        Effect.provideService(EffectDbService, effectDbFor(localD1Binding(db.$client), "fetch")),
      ),
  );
}

async function archiveOf(
  db: TestDb,
  sources: { assets?: ArchiveAssetsSource; sheets?: ReturnType<typeof createR2Stub> },
  limits?: ArchiveLimits,
) {
  const plan = await readPlan(db);
  const stream = weddingArchiveService.stream(plan, sources, limits);
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const texts = zipTexts(bytes);
  const manifest = JSON.parse(texts.get(`${FOLDER}manifest.json`) ?? "null") as {
    data: { path: string; complete: boolean; rowsInWedding?: number; rowsInFile?: number }[];
    files: { what: string; path: string | null; status: string }[];
  };
  return { bytes, entries: readZip(bytes), texts, manifest };
}

describe("who may download a wedding (refusals)", () => {
  it("A1: no session is refused", async () => {
    const { app } = buildApp();
    expect((await post(app)).status).toBe(401);
  });

  it("A1: a cookie naming no session, or a token signed by another key, is refused before any read", async () => {
    const { db, app } = buildApp();
    const stranger = await makeOsnTestAuth();
    const statements = recordStatements(db);
    const cookie = await appRequest(app, ARCHIVE, {
      method: "POST",
      headers: { cookie: `cire_org_session=${"x".repeat(43)}` },
    });
    const forged = await appRequest(app, ARCHIVE, {
      method: "POST",
      headers: { Authorization: `Bearer ${await stranger.sign(OWNER)}` },
    });
    expect([cookie.status, forged.status]).toEqual([401, 401]);
    expect(statements.some((s) => s.sql.includes('"budget_items"'))).toBe(false);
  });

  it("A2–A5: an editor, a viewer, a helper and another wedding's owner are refused", async () => {
    const { app } = buildApp();
    for (const who of [EDITOR, VIEWER, HELPER, OTHER_OWNER]) {
      const res = await post(app, who);
      expect({
        who,
        status: res.status,
        json: res.headers.get("content-type")?.startsWith("application/json"),
      }).toEqual({
        who,
        status: 403,
        json: true,
      });
    }
  });

  it("A6: a deleted wedding answers as an unknown one, to its owner too", async () => {
    const { app } = buildApp({ deletedAt: new Date() });
    expect((await post(app, OWNER)).status).toBe(404);
  });

  it("A7: the archive's own limit refuses before any read, and an archive spends the shared one", async () => {
    const limited = buildApp({
      archiveLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    expect((await post(limited.app, OWNER)).status).toBe(200);
    const statements = recordStatements(limited.db);
    expect((await post(limited.app, OWNER)).status).toBe(429);
    expect(statements.some((s) => s.sql.includes('"budget_items"'))).toBe(false);

    const shared = buildApp({
      exportLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    expect((await post(shared.app, OWNER)).status).toBe(200);
    const csv = await appRequest(shared.app, `/api/organiser/weddings/${W}/tasks.csv`, {
      headers: { Authorization: `Bearer ${await auth.sign(OWNER)}` },
    });
    expect(csv.status).toBe(429);

    // A refused archive spends nothing from the shared allowance.
    const both = buildApp({
      archiveLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
      exportLimiter: createRateLimiter({ maxRequests: 2, windowMs: 60_000 }),
    });
    expect((await post(both.app, OWNER)).status).toBe(200);
    expect((await post(both.app, OWNER)).status).toBe(429);
    const tasksCsv = async () =>
      (
        await appRequest(both.app, `/api/organiser/weddings/${W}/tasks.csv`, {
          headers: { Authorization: `Bearer ${await auth.sign(OWNER)}` },
        })
      ).status;
    expect(await tasksCsv()).toBe(200);
    expect(await tasksCsv()).toBe(429);

    const get = await appRequest(limited.app, ARCHIVE, {
      headers: { Authorization: `Bearer ${await auth.sign(OWNER)}` },
    });
    expect(get.status).toBe(404);
  });

  it("A7: with no limiter given, an owner's eleventh archive in a day is refused", async () => {
    const db = createDb(":memory:");
    // An owner of their own, so no other test's archive shares the default limiter's bucket.
    const owner = "usr_daily_owner";
    insertWedding(db, { id: W, slug: `slug-${W}`, displayName: "Daily", owners: [owner] });
    const app = createApp(db, {
      osnTestKey: auth.key,
      effectDb: effectDbFor(localD1Binding(db.$client), "fetch"),
      exportLimiter: generous(),
    });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      // oxlint-disable-next-line no-await-in-loop -- the limiter counts them in order
      const res = await post(app, owner);
      statuses.push(res.status);
      // oxlint-disable-next-line no-await-in-loop -- each archive is read to its end
      await res.arrayBuffer();
    }
    expect(statuses).toEqual([...Array.from({ length: 10 }, () => 200), 429]);
  });

  it("A10: no plan tier locks the archive, and it holds the modules the tier shuts", async () => {
    const { db, app } = buildApp();
    setTier(db, W, "ivory");
    const res = await post(app, OWNER);
    expect(res.status).toBe(200);
    const texts = zipTexts(new Uint8Array(await res.arrayBuffer()));
    expect(texts.get(`${FOLDER}budget.csv`)).toContain("Hall");
    expect(texts.get(`${FOLDER}tasks.csv`)).toContain("Book");
    expect(texts.get(`${FOLDER}vendors.csv`)).toContain("Florist");
    expect(texts.get(`${FOLDER}registry.csv`)).toContain("Vase");
  });

  it("A9: the archive is never stored by anything on the way", async () => {
    const { app } = buildApp();
    const ok = await counterValue(CIRE_METRICS.weddingArchiveDownloads, { result: "ok" });
    const res = await post(app, OWNER);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="cire-wedding-slug-${W}.zip"`,
    );
    expect(readZip(new Uint8Array(await res.arrayBuffer())).every((e) => e.crcMatches)).toBe(true);
    expect(await counterValue(CIRE_METRICS.weddingArchiveDownloads, { result: "ok" })).toBe(ok + 1);
  });

  it("B15: the sheets for setting the wedding up again carry no ids and no live household code", async () => {
    const { db, assets, sheets } = seedWedding();
    const { texts } = await archiveOf(db, { assets, sheets });
    expect(texts.get(`${FOLDER}guests.csv`)).toContain(fullWeddingCode(W));
    expect(texts.get(`${FOLDER}for-import/guests.csv`)).not.toContain(fullWeddingCode(W));
    expect(texts.get(`${FOLDER}for-import/events.csv`)).not.toContain(`evt_${W}`);
  });
});

describe("what an archive holds when R2 or a limit gets in the way", () => {
  it("B1: a file that would pass the byte limit is left out; a smaller one after it fits, to the byte", async () => {
    const { db } = seedWedding();
    const assets = createAssetsStub();
    const [hero, story, footer, event, registry] = fullWeddingKeys(W).assets;
    assets.put(hero!, jpeg(57), { httpMetadata: { contentType: "image/jpeg" } }); // 60 bytes
    assets.put(story!, jpeg(57), { httpMetadata: { contentType: "image/jpeg" } }); // 60 bytes
    assets.put(footer!, jpeg(7), { httpMetadata: { contentType: "image/jpeg" } }); // 10 bytes
    assets.put(event!, jpeg(7), { httpMetadata: { contentType: "image/jpeg" } }); // 10 bytes
    assets.put(registry!, jpeg(17), { httpMetadata: { contentType: "image/jpeg" } }); // 20: exactly 100
    const { manifest, texts } = await archiveOf(db, { assets }, { files: 900, bytes: 100 });
    const status = new Map(manifest.files.map((f) => [f.what, f]));
    expect(status.get("Invite image: hero")).toMatchObject({ status: "included" });
    expect(status.get("Invite image: story")).toMatchObject({ status: "over_limit", path: null });
    expect(status.get("Invite image: footer")).toMatchObject({ status: "included" });
    expect(status.get("Gift image: Vase")).toMatchObject({
      status: "included",
      path: "files/registry/001-vase.jpg",
    });
    expect([...texts.keys()].some((name) => name.includes("files/invite/story"))).toBe(false);
  });

  it("B2: past the file-count limit, the rest are never read", async () => {
    const { db, assets, sheets } = seedWedding();
    const reads: string[] = [];
    const counted: AssetsBucket = {
      ...assets,
      get: (key) => {
        reads.push(key);
        return assets.get(key);
      },
    };
    const { manifest } = await archiveOf(db, { assets: counted, sheets }, { files: 1, bytes: 1e9 });
    expect(reads).toHaveLength(1);
    expect(manifest.files.filter((f) => f.status === "included")).toHaveLength(1);
    expect(manifest.files.filter((f) => f.status === "over_limit").length).toBe(
      manifest.files.length - 1,
    );
  });

  it("B3: a missing object, a failed read and an absent bucket are named, and the archive still holds", async () => {
    const { db } = seedWedding();
    const assets = createAssetsStub();
    const [hero, story] = fullWeddingKeys(W).assets;
    assets.put(hero!, jpeg(16), { httpMetadata: { contentType: "image/jpeg" } });
    const failing: AssetsBucket = {
      ...assets,
      get: (key) => (key === story ? Promise.reject(new Error("r2 down")) : assets.get(key)),
    };
    // One of the two uploaded sheets is gone from R2.
    const sheets = createR2Stub();
    sheets.put(fullWeddingKeys(W).sheets[0]!, "Events\n");
    const before = await counterValue(CIRE_METRICS.weddingArchiveFiles, { status: "unreadable" });
    const withAssets = await archiveOf(db, { assets: failing, sheets });
    const status = new Map(withAssets.manifest.files.map((f) => [f.what, f.status]));
    expect(status.get("Invite image: hero")).toBe("included");
    expect(status.get("Invite image: story")).toBe("unreadable");
    expect(status.get("Invite image: footer")).toBe("missing");
    expect(
      withAssets.manifest.files.filter((f) => f.what.startsWith("Uploaded")).map((f) => f.status),
    ).toEqual(["included", "missing"]);
    expect(withAssets.entries.every((entry) => entry.crcMatches)).toBe(true);
    expect(await counterValue(CIRE_METRICS.weddingArchiveFiles, { status: "unreadable" })).toBe(
      before + 1,
    );

    const noBucket = await archiveOf(db, {});
    expect(noBucket.manifest.files.length).toBe(7);
    expect(noBucket.manifest.files.every((f) => f.status === "unavailable")).toBe(true);
  });

  it("B4: every data file cut at its ceiling says so, with both counts", async () => {
    const { db, assets, sheets } = seedWedding();
    const bulk = (sql: string) => db.$client.run(sql);
    const n = (count: number) =>
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count}) SELECT i FROM n`;
    // `fullWeddingStatements` already holds one row in each of these.
    bulk(
      `INSERT INTO tasks (id, wedding_id, title, timeframe_bucket, created_at) SELECT 'tb_' || i, '${W}', 'Task', '1m', 0 FROM (${n(MAX_PLANNING_EXPORT_ROWS)})`,
    );
    bulk(
      `INSERT INTO budget_items (id, wedding_id, category, name, created_at, updated_at) SELECT 'bb_' || i, '${W}', 'venue', 'Line', 0, 0 FROM (${n(MAX_PLANNING_EXPORT_ROWS)})`,
    );
    bulk(
      `INSERT INTO vendors (id, wedding_id, name, category, created_at, updated_at) SELECT 'vb_' || i, '${W}', 'Vendor', 'venue', 0, 0 FROM (${n(MAX_VENDOR_EXPORT_ROWS)})`,
    );
    bulk(
      `INSERT INTO registry_items (id, wedding_id, title, created_at, updated_at) SELECT 'rb_' || i, '${W}', 'Item', 0, 0 FROM (${n(MAX_REGISTRY_EXPORT_ROWS)})`,
    );
    bulk(
      `INSERT INTO wedding_faqs (id, wedding_id, question, answer, created_at, updated_at) SELECT 'qb_' || i, '${W}', 'Q', 'A', 0, 0 FROM (${n(MAX_QUESTION_EXPORT_ROWS)})`,
    );
    bulk(
      `INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at) SELECT 'fb_' || i, '${W}', 'FB-' || i, 'Bulk', 0, 0 FROM (${n(MAX_HOUSEHOLD_EXPORT_ROWS)})`,
    );
    // One more gift than the ceiling: a claim by each new household on the one item.
    bulk(
      `INSERT INTO registry_claims (id, wedding_id, item_id, family_id, created_at, updated_at) SELECT 'cb_' || i, '${W}', 'ritem_${W}', 'fb_' || i, 0, 0 FROM (${n(MAX_GIFT_EXPORT_ROWS - 1)})`,
    );
    // One more seat than the ceiling, at the plan in use: a guest of each new household.
    bulk(
      `INSERT INTO guests (id, family_id, first_name, created_at, updated_at) SELECT 'gb_' || i, 'fb_' || i, 'Guest', 0, 0 FROM (${n(MAX_SEATING_EXPORT_ROWS / 2)})`,
    );
    bulk(
      `INSERT INTO guests (id, family_id, first_name, created_at, updated_at) SELECT 'gc_' || i, 'fb_' || i, 'Guest', 0, 0 FROM (${n(MAX_SEATING_EXPORT_ROWS / 2)})`,
    );
    bulk(
      `INSERT INTO guest_events (guest_id, event_id) SELECT id, 'evt_${W}' FROM guests WHERE id LIKE 'gb_%' OR id LIKE 'gc_%'`,
    );
    bulk(
      `INSERT INTO seating_assignments (table_id, plan_id, event_id, guest_id, created_at) SELECT 'stb_${W}', 'spl_${W}', 'evt_${W}', id, 0 FROM guests WHERE id LIKE 'gb_%' OR id LIKE 'gc_%'`,
    );

    const { manifest } = await archiveOf(db, { assets, sheets });
    const cut = (path: string, ceiling: number, inWedding: number) => ({
      path,
      complete: false,
      rowsInWedding: inWedding,
      rowsInFile: ceiling,
    });
    const capped = manifest.data.filter((d) => !d.complete);
    expect(capped).toEqual([
      cut("households.csv", MAX_HOUSEHOLD_EXPORT_ROWS, MAX_HOUSEHOLD_EXPORT_ROWS + 1),
      cut("seating.csv", MAX_SEATING_EXPORT_ROWS, MAX_SEATING_EXPORT_ROWS + 1),
      cut("seating-plans.csv", MAX_SEATING_EXPORT_ROWS, MAX_SEATING_EXPORT_ROWS + 1),
      cut("registry.csv", MAX_REGISTRY_EXPORT_ROWS, MAX_REGISTRY_EXPORT_ROWS + 1),
      cut("gifts.csv", MAX_GIFT_EXPORT_ROWS, MAX_GIFT_EXPORT_ROWS + 1),
      // Lines and their payments: the fixture's one line has a payment.
      cut("budget.csv", MAX_PLANNING_EXPORT_ROWS, MAX_PLANNING_EXPORT_ROWS + 2),
      cut("tasks.csv", MAX_PLANNING_EXPORT_ROWS, MAX_PLANNING_EXPORT_ROWS + 1),
      cut("vendors.csv", MAX_VENDOR_EXPORT_ROWS, MAX_VENDOR_EXPORT_ROWS + 1),
      cut("questions.csv", MAX_QUESTION_EXPORT_ROWS, MAX_QUESTION_EXPORT_ROWS + 1),
    ]);
  });

  it("B4: a file exactly at its ceiling is whole, and the host's preview household is not counted", async () => {
    const { db, assets, sheets } = seedWedding();
    const n = (count: number) =>
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count}) SELECT i FROM n`;
    db.$client.run(
      `INSERT INTO tasks (id, wedding_id, title, timeframe_bucket, created_at) SELECT 'tb_' || i, '${W}', 'Task', '1m', 0 FROM (${n(MAX_PLANNING_EXPORT_ROWS - 1)})`,
    );
    db.$client.run(
      `INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at) SELECT 'fb_' || i, '${W}', 'FB-' || i, 'Bulk', 0, 0 FROM (${n(MAX_HOUSEHOLD_EXPORT_ROWS - 1)})`,
    );
    db.$client.run(
      `INSERT INTO families (id, wedding_id, public_id, family_name, kind, created_at, updated_at) VALUES ('fam_host', '${W}', 'HOST-W1', 'Host', 'host', 0, 0)`,
    );
    const { manifest } = await archiveOf(db, { assets, sheets });
    expect(manifest.data.every((d) => d.complete)).toBe(true);
  });

  it("B5: a name from the wedding can never leave its folder or take another's place", async () => {
    const { db, assets, sheets } = seedWedding();
    const hostile = [
      "../../x",
      "/",
      "\\",
      "",
      "a".repeat(300),
      "Café",
      "Café",
      "Smith & Jones",
      "Rehearsal dinner!",
      `${"b".repeat(39)} c`,
    ];
    db.insert(events)
      .values(
        hostile.map((name, i) => ({
          id: `evt_hostile_${i}`,
          weddingId: W,
          slug: `hostile-${i}`,
          name,
          startAt: "2027-01-02T10:00",
          endAt: "",
          timezone: "UTC",
          sortOrder: 10 + i,
          eventImageKey: `assets/${W}/event-hostile-${i}`,
        })),
      )
      .run();
    hostile.forEach((_, i) => {
      assets.put(`assets/${W}/event-hostile-${i}`, jpeg(4), {
        httpMetadata: { contentType: "image/jpeg" },
      });
    });
    const { entries } = await archiveOf(db, { assets, sheets });
    const names = entries.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.startsWith(FOLDER)).toBe(true);
      expect(name).not.toMatch(/\\|(^|\/)\.\.?(\/|$)|\/\//);
    }
    expect(names.filter((name) => name.includes("/files/events/"))).toEqual(
      [
        "001-ceremony",
        "002-x",
        "003-event",
        "004-event",
        "005-event",
        `006-${"a".repeat(40)}`,
        "007-cafe",
        "008-cafe",
        "009-smith-jones",
        "010-rehearsal-dinner",
        `011-${"b".repeat(39)}`,
      ].map((stem) => `${FOLDER}files/events/${stem}.jpg`),
    );
    db.$client.run(
      `INSERT INTO registry_items (id, wedding_id, title, image_key, sort_order, created_at, updated_at) VALUES ('ritem_untitled', '${W}', '', 'assets/${W}/registry-untitled', 1, 0, 0)`,
    );
    assets.put(`assets/${W}/registry-untitled`, jpeg(4), {
      httpMetadata: { contentType: "image/jpeg" },
    });
    const again = await archiveOf(db, { assets, sheets });
    expect(again.manifest.files.find((f) => f.what === "Event image: Smith & Jones")?.path).toBe(
      "files/events/009-smith-jones.jpg",
    );
    expect(again.manifest.files.find((f) => f.what === "Gift image: ")?.path).toBe(
      "files/registry/002-gift.jpg",
    );
  });

  it("B5: a picture stored with no type is named by its bytes, and one it cannot tell as .bin", async () => {
    const { db, sheets } = seedWedding();
    const assets = createAssetsStub();
    const [hero, story, footer, event] = fullWeddingKeys(W).assets;
    assets.put(hero!, jpeg(4));
    assets.put(story!, new Uint8Array([1, 2, 3, 4]));
    assets.put(footer!, new Uint8Array([1]), { httpMetadata: { contentType: "image/png" } });
    assets.put(event!, new Uint8Array([1]), { httpMetadata: { contentType: "image/webp" } });
    const { entries } = await archiveOf(db, { assets, sheets });
    const pictures = entries
      .map((e) => e.name)
      .filter((name) => /\/files\/(invite|events)\//.test(name));
    expect(pictures).toEqual([
      `${FOLDER}files/invite/hero.jpg`,
      `${FOLDER}files/invite/story.bin`,
      `${FOLDER}files/invite/footer.png`,
      `${FOLDER}files/events/001-ceremony.webp`,
    ]);
  });

  it("B6: one whole download stays within D1's 50 statements a request, sign-in included", async () => {
    const { db, assets, sheets } = seedWedding();
    const app = createApp(db, {
      effectDb: effectDbFor(localD1Binding(db.$client), "fetch"),
      assets,
      r2: sheets,
      archiveLimiter: generous(),
      exportLimiter: generous(),
    });
    const session = await seedOrganiserSession(db, OWNER);
    const statements = recordStatements(db);
    const res = await appRequest(app, ARCHIVE, {
      method: "POST",
      headers: { cookie: `cire_org_session=${session}` },
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(statements.length).toBeGreaterThan(10);
    expect(statements.length).toBeLessThanOrEqual(50);
  });

  it("B7: a failed read answers 500 before any archive byte, and logs the wedding only", async () => {
    const { db, app } = buildApp();
    const before = await counterValue(CIRE_METRICS.weddingArchiveDownloads, { result: "error" });
    const failing = failStatements(db, (sql) => sql.includes('"budget_items"'));
    let res: Response | undefined;
    const logs = await captureLogs(async () => {
      res = await post(app, OWNER);
    });
    failing.restore();
    expect(failing.failed()).toBeGreaterThan(0);
    expect(res?.status).toBe(500);
    expect(await res?.json()).toEqual({ error: "Internal error" });
    expect(logs).toContain("wedding archive read failed");
    expect(logs).toContain(W);
    for (const row of ["Ada", "Hall", "Vase", "Florist", OWNER]) expect(logs).not.toContain(row);
    expect(await counterValue(CIRE_METRICS.weddingArchiveDownloads, { result: "error" })).toBe(
      before + 1,
    );
  });

  it("B7: an app built without the D1 Effect handle refuses with 500 rather than a partial archive", async () => {
    const { db, assets, sheets } = seedWedding();
    const app = createApp(db, {
      osnTestKey: auth.key,
      assets,
      r2: sheets,
      archiveLimiter: generous(),
      exportLimiter: generous(),
    });
    const res = await post(app, OWNER);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal error" });
  });

  it("B9: the couple's applied and reverted uploads go in, newest first; a preview and cire's own snapshots do not", async () => {
    const { db, assets, sheets } = seedWedding();
    const at = Date.parse("2026-10-02T00:00:00Z");
    for (const [id, status, kind] of [
      ["imp_reverted", "reverted", "import"],
      ["imp_preview", "preview", "import"],
      ["imp_editor", "applied", "editor"],
    ] as const) {
      db.$client
        .query(
          "INSERT INTO imports (id, wedding_id, uploaded_at, format, events_r2_key, guests_r2_key, summary, status, kind) VALUES (?, ?, ?, 'tsv', ?, ?, '{}', ?, ?)",
        )
        .run(id, W, at, `imports/${id}/events.csv`, `imports/${id}/guests.csv`, status, kind);
      sheets.put(`imports/${id}/events.csv`, `Events,${id}\n`);
      sheets.put(`imports/${id}/guests.csv`, `Guests,${id}\n`);
    }
    const { texts, manifest } = await archiveOf(db, { assets, sheets });
    const uploads = [...texts.entries()].filter(([name]) => name.includes("/files/uploads/"));
    expect(uploads.map(([name]) => name.slice(FOLDER.length))).toEqual([
      "files/uploads/2026-10-02-001-events.csv",
      "files/uploads/2026-10-02-001-guests.csv",
      "files/uploads/1970-01-21-002-events.csv",
      "files/uploads/1970-01-21-002-guests.csv",
    ]);
    const contents = uploads.map(([, text]) => text).join("");
    expect(contents).toContain("imp_reverted");
    expect(contents).not.toContain("imp_preview");
    expect(contents).not.toContain("imp_editor");
    expect(contents).not.toContain("/before/");
    expect(manifest.files.filter((f) => f.what.startsWith("Uploaded")).map((f) => f.what)).toEqual([
      "Uploaded events sheet, 2026-10-02",
      "Uploaded guest sheet, 2026-10-02",
      "Uploaded events sheet, 1970-01-21",
      "Uploaded guest sheet, 1970-01-21",
    ]);
  });

  it("B16: another wedding's rows never reach an archive", async () => {
    const { db, assets, sheets } = seedWedding();
    const before = await archiveOf(db, { assets, sheets });
    const now = new Date("2026-10-01T00:00:00Z");
    db.delete(weddings).where(eq(weddings.id, "w2")).run();
    for (const statement of fullWeddingStatements("w2", { owner: OTHER_OWNER, now })) {
      db.run(statement);
    }
    for (const key of fullWeddingKeys("w2").assets) {
      assets.put(key, jpeg(16), { httpMetadata: { contentType: "image/jpeg" } });
    }
    for (const key of fullWeddingKeys("w2").sheets) sheets.put(key, `Sheet,${key}\n`);
    const after = await archiveOf(db, { assets, sheets });
    expect(after.entries.map((e) => e.name)).toEqual(before.entries.map((e) => e.name));
    for (const [i, entry] of after.entries.entries()) {
      expect({
        name: entry.name,
        same: Buffer.from(entry.bytes).equals(Buffer.from(before.entries[i]!.bytes)),
      }).toEqual({
        name: entry.name,
        same: true,
      });
    }
    expect([...after.texts.values()].join("")).not.toContain(fullWeddingCode("w2"));
  });

  it("B17: an uploaded sheet comes out through the formula guard", async () => {
    const { db, assets } = seedWedding();
    const sheets = createR2Stub();
    const [eventsKey, guestsKey] = fullWeddingKeys(W).sheets;
    sheets.put(eventsKey!, "Name,Notes\r\nDinner,a;=1+1\r\n");
    sheets.put(guestsKey!, "Name,Notes\r\nAda,\u200b=1+1\r\n");
    // A third upload whose sheets are empty comes out empty.
    db.$client.run(
      `INSERT INTO imports (id, wedding_id, uploaded_at, format, events_r2_key, guests_r2_key, summary, status, kind) VALUES ('imp_empty', '${W}', 0, 'csv', 'imports/imp_empty/events.csv', 'imports/imp_empty/guests.csv', '{}', 'applied', 'import')`,
    );
    sheets.put("imports/imp_empty/events.csv", "");
    sheets.put("imports/imp_empty/guests.csv", "");
    const { texts } = await archiveOf(db, { assets, sheets });
    const uploads = [...texts.entries()]
      .filter(([name]) => name.includes("/files/uploads/"))
      .map(([, text]) => text);
    expect(uploads).toEqual([
      ["Name,Notes", "Dinner,a;'=1+1"].join("\r\n"),
      ["Name,Notes", "Ada,\u200b'=1+1"].join("\r\n"),
      "",
      "",
    ]);
  });

  it("B18: a picture whose key names another wedding is never fetched", async () => {
    const { db, sheets } = seedWedding();
    const assets = createAssetsStub();
    const foreign = "assets/w2/registry-elsewhere";
    assets.put(foreign, jpeg(4), { httpMetadata: { contentType: "image/jpeg" } });
    db.$client.run(`UPDATE registry_items SET image_key = '${foreign}' WHERE id = 'ritem_${W}'`);
    const reads: string[] = [];
    const counted: AssetsBucket = {
      ...assets,
      get: (key) => {
        reads.push(key);
        return assets.get(key);
      },
    };
    const { manifest } = await archiveOf(db, { assets: counted, sheets });
    expect(manifest.files.find((f) => f.what === "Gift image: Vase")?.status).toBe("missing");
    expect(reads).not.toContain(foreign);
  });

  it("B1: a picture R2 says would pass the byte limit is let go without reading its body", async () => {
    const { db, sheets } = seedWedding();
    const [hero] = fullWeddingKeys(W).assets;
    let bodyRead = false;
    let cancelled = false;
    const sized: AssetsBucket = {
      put: () => undefined,
      delete: () => undefined,
      get: (key) =>
        key === hero
          ? {
              size: 1_000,
              arrayBuffer: () => {
                bodyRead = true;
                return Promise.resolve(jpeg(997).buffer);
              },
              body: new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
              httpMetadata: { contentType: "image/jpeg" },
            }
          : null,
    };
    const { manifest } = await archiveOf(db, { assets: sized, sheets }, { files: 900, bytes: 100 });
    expect(manifest.files.find((f) => f.what === "Invite image: hero")?.status).toBe("over_limit");
    expect({ bodyRead, cancelled }).toEqual({ bodyRead: false, cancelled: true });
  });

  it("B1: a picture R2 says fits, to the byte, is read and included; one with no body to let go is still left out", async () => {
    const { db, sheets } = seedWedding();
    const [hero, story, footer] = fullWeddingKeys(W).assets;
    const object = (bytes: Uint8Array, withBody = true) => ({
      size: bytes.byteLength,
      arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
      ...(withBody ? { body: new ReadableStream<Uint8Array>() } : {}),
      httpMetadata: { contentType: "image/jpeg" },
    });
    const sized: ArchiveAssetsSource = {
      get: (key) =>
        key === hero
          ? object(jpeg(57)) // 60 bytes
          : key === story
            ? object(jpeg(37)) // 40: exactly 100 in all
            : key === footer
              ? object(jpeg(7), false) // 10 more: over, and no body to cancel
              : null,
    };
    const { manifest } = await archiveOf(db, { assets: sized, sheets }, { files: 900, bytes: 100 });
    const status = new Map(manifest.files.map((f) => [f.what, f.status]));
    expect(status.get("Invite image: hero")).toBe("included");
    expect(status.get("Invite image: story")).toBe("included");
    expect(status.get("Invite image: footer")).toBe("over_limit");
  });

  it("B11: a new wedding with nothing in it, and pictures nowhere, still downloads whole", async () => {
    const db = createDb(":memory:");
    insertWedding(db, { id: W, slug: `slug-${W}`, displayName: "New", owners: [OWNER] });
    db.insert(events)
      .values({
        id: "evt_plain",
        weddingId: W,
        slug: "day",
        name: "Day",
        startAt: "",
        endAt: "",
        timezone: "UTC",
      })
      .run();
    db.$client.run(
      `INSERT INTO registry_items (id, wedding_id, title, created_at, updated_at) VALUES ('ritem_plain', '${W}', 'Plain', 0, 0)`,
    );
    const { manifest, entries } = await archiveOf(db, {
      assets: createAssetsStub(),
      sheets: createR2Stub(),
    });
    expect(manifest.files).toEqual([]);
    expect(manifest.data.every((d) => d.complete)).toBe(true);
    expect(entries.map((e) => e.name)).toContain(`${FOLDER}manifest.json`);
  });

  it("B13: a reader that stops reading stops the R2 reads", async () => {
    const { db, assets, sheets } = seedWedding();
    const reads: string[] = [];
    const counted: AssetsBucket = {
      ...assets,
      get: (key) => {
        reads.push(key);
        return assets.get(key);
      },
    };
    const plan = await readPlan(db);
    const reader = weddingArchiveService.stream(plan, { assets: counted, sheets }).getReader();
    // The README, then every data file: no picture is read before its turn.
    for (let i = 0; i <= plan.data.length; i++) await reader.read();
    await reader.cancel();
    expect(reads).toEqual([]);
  });

  it("B14: a fault while writing ends the stream with no end record, and logs the wedding only", async () => {
    const { db, assets, sheets } = seedWedding();
    const plan = await readPlan(db);
    const faulty = {
      ...plan,
      data: [
        {
          path: "broken.csv",
          complete: true,
          get text(): string {
            throw new Error("Ada Hall");
          },
        },
      ],
    };
    const before = await counterValue(CIRE_METRICS.weddingArchiveDownloads, { result: "error" });
    let failed = false;
    const logs = await captureLogs(async () => {
      try {
        await new Response(weddingArchiveService.stream(faulty, { assets, sheets })).arrayBuffer();
      } catch {
        failed = true;
      }
    });
    expect(failed).toBe(true);
    expect(logs).toContain("wedding archive stream failed");
    expect(logs).toContain(W);
    expect(logs).not.toContain("Ada");
    expect(await counterValue(CIRE_METRICS.weddingArchiveDownloads, { result: "error" })).toBe(
      before + 1,
    );
  });
});
