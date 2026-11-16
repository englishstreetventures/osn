import { beforeAll, describe, expect, it } from "bun:test";

import { events, tasks, weddingHosts } from "@cire/db";
import { createRateLimiter } from "@shared/rate-limit";
import { Effect } from "effect";

import { createApp } from "../../src/app";
import { DbService } from "../../src/db";
import { EffectDbService, effectDbFor } from "../../src/db/effect-handle";
import { localD1Binding } from "../../src/db/local-d1";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import { createAssetsStub } from "../../src/services/invite-assets";
import type { AssetsBucket } from "../../src/services/invite-assets";
import { MAX_PLANNING_EXPORT_ROWS } from "../../src/services/planning-export";
import { createR2Stub } from "../../src/services/r2-imports";
import { weddingArchiveService } from "../../src/services/wedding-archive";
import type { ArchiveLimits } from "../../src/services/wedding-archive";
import { appRequest, failStatements, recordStatements } from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { fullWeddingKeys, fullWeddingStatements } from "../test-helpers/full-wedding";
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
  for (const statement of fullWeddingStatements(W, { owner: OWNER, deletedAt: opts.deletedAt })) {
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
  sources: { assets?: AssetsBucket; sheets?: ReturnType<typeof createR2Stub> },
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

    const get = await appRequest(limited.app, ARCHIVE, {
      headers: { Authorization: `Bearer ${await auth.sign(OWNER)}` },
    });
    expect(get.status).toBe(404);
  });

  it("A9: the archive is never stored by anything on the way", async () => {
    const { app } = buildApp();
    const res = await post(app, OWNER);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="cire-wedding-slug-${W}.zip"`,
    );
    expect(readZip(new Uint8Array(await res.arrayBuffer())).every((e) => e.crcMatches)).toBe(true);
  });
});

describe("what an archive holds when R2 or a limit gets in the way", () => {
  it("B1: a file that would pass the byte limit is left out; a smaller one after it fits", async () => {
    const { db } = seedWedding();
    const assets = createAssetsStub();
    const [hero, story, footer, event, registry] = fullWeddingKeys(W).assets;
    assets.put(hero!, jpeg(57), { httpMetadata: { contentType: "image/jpeg" } }); // 60 bytes
    assets.put(story!, jpeg(57), { httpMetadata: { contentType: "image/jpeg" } }); // 60 bytes
    for (const key of [footer!, event!, registry!]) {
      assets.put(key, jpeg(7), { httpMetadata: { contentType: "image/jpeg" } }); // 10 bytes
    }
    const { manifest, texts } = await archiveOf(db, { assets }, { files: 900, bytes: 100 });
    const status = new Map(manifest.files.map((f) => [f.what, f]));
    expect(status.get("Invite image: hero")).toMatchObject({ status: "included" });
    expect(status.get("Invite image: story")).toMatchObject({ status: "over_limit", path: null });
    expect(status.get("Invite image: footer")).toMatchObject({ status: "included" });
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
    const { db, sheets } = seedWedding();
    const assets = createAssetsStub();
    const [hero, story] = fullWeddingKeys(W).assets;
    assets.put(hero!, jpeg(16), { httpMetadata: { contentType: "image/jpeg" } });
    const failing: AssetsBucket = {
      ...assets,
      get: (key) => (key === story ? Promise.reject(new Error("r2 down")) : assets.get(key)),
    };
    const before = await counterValue(CIRE_METRICS.weddingArchiveFiles, { status: "unreadable" });
    const withAssets = await archiveOf(db, { assets: failing, sheets });
    const status = new Map(withAssets.manifest.files.map((f) => [f.what, f.status]));
    expect(status.get("Invite image: hero")).toBe("included");
    expect(status.get("Invite image: story")).toBe("unreadable");
    expect(status.get("Invite image: footer")).toBe("missing");
    expect(withAssets.entries.every((entry) => entry.crcMatches)).toBe(true);
    expect(await counterValue(CIRE_METRICS.weddingArchiveFiles, { status: "unreadable" })).toBe(
      before + 1,
    );

    const noBucket = await archiveOf(db, { sheets });
    const images = noBucket.manifest.files.filter((f) => f.what.includes("image"));
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((f) => f.status === "unavailable")).toBe(true);
  });

  it("B4: a data file cut at its ceiling says so", async () => {
    const { db, assets, sheets } = seedWedding();
    db.insert(tasks)
      .values(
        Array.from({ length: MAX_PLANNING_EXPORT_ROWS }, (_, i) => ({
          id: `task_extra_${i}`,
          weddingId: W,
          title: `Task ${i}`,
          timeframeBucket: "1m",
          createdAt: new Date(),
        })),
      )
      .run();
    const { manifest } = await archiveOf(db, { assets, sheets });
    const file = (path: string) => manifest.data.find((d) => d.path === path);
    expect(file("tasks.csv")).toEqual({
      path: "tasks.csv",
      complete: false,
      rowsInWedding: MAX_PLANNING_EXPORT_ROWS + 1,
      rowsInFile: MAX_PLANNING_EXPORT_ROWS,
    });
    expect(file("budget.csv")).toEqual({ path: "budget.csv", complete: true });
  });

  it("B5: a name from the wedding can never leave its folder or take another's place", async () => {
    const { db, assets, sheets } = seedWedding();
    const hostile = ["../../x", "/", "\\", "", "a".repeat(300), "Café", "Café"];
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
      expect(name.length).toBeLessThan(120);
    }
    expect(names.filter((name) => name.includes("/files/events/"))).toHaveLength(
      hostile.length + 1,
    );
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
    expect(res?.headers.get("content-type")).toStartWith("application/json");
    expect(logs).toContain("wedding archive read failed");
    expect(logs).toContain(W);
    for (const row of ["Ada", "Hall", "Vase", "Florist", OWNER]) expect(logs).not.toContain(row);
    expect(await counterValue(CIRE_METRICS.weddingArchiveDownloads, { result: "error" })).toBe(
      before + 1,
    );
  });

  it("B9: the couple's applied and reverted uploads go in; a preview and cire's own snapshots do not", async () => {
    const { db, assets, sheets } = seedWedding();
    const at = Date.parse("2026-10-02T00:00:00Z");
    for (const [id, status, kind] of [
      ["imp_reverted", "reverted", "import"],
      ["imp_preview", "preview", "import"],
      ["imp_editor", "applied", "editor"],
    ] as const) {
      db.$client
        .query(
          "INSERT INTO imports (id, wedding_id, uploaded_at, format, events_r2_key, guests_r2_key, summary, status, kind) VALUES (?, ?, ?, 'csv', ?, ?, '{}', ?, ?)",
        )
        .run(id, W, at, `imports/${id}/events.csv`, `imports/${id}/guests.csv`, status, kind);
      sheets.put(`imports/${id}/events.csv`, `Events,${id}\n`);
      sheets.put(`imports/${id}/guests.csv`, `Guests,${id}\n`);
    }
    const { texts } = await archiveOf(db, { assets, sheets });
    const uploads = [...texts.entries()].filter(([name]) => name.includes("/files/uploads/"));
    const contents = uploads.map(([, text]) => text).join("");
    expect(uploads).toHaveLength(4);
    expect(contents).toContain("imp_reverted");
    expect(contents).toContain(`imports/imp_${W}/events.csv`);
    expect(contents).not.toContain("imp_preview");
    expect(contents).not.toContain("imp_editor");
    expect(contents).not.toContain("/before/");
  });
});
