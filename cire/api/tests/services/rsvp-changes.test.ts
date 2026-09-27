import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  families,
  guests,
  hostRsvpNotices,
  rsvpChanges,
  weddings,
} from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { and, asc, eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import { commitBatch, DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import {
  buildRecordStatement,
  buildUnseenQuery,
  classifyRsvpChanges,
  pairKey,
  RSVP_CHANGE_RETENTION_MS,
  rsvpChangeService,
  summariseUnseen,
  UNSEEN_ROW_LIMIT,
  type PriorReply,
} from "../../src/services/rsvp-changes";
import { counterValue } from "../test-helpers/metrics-harness";

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_changes_editor";
const HINDU = eventsData.hindu.id;
const RECEPTION = eventsData.reception.id;

function fixture() {
  const db = createDb(":memory:");
  seedDb(db);
  const rows = db
    .select({ id: guests.id, firstName: guests.firstName, familyId: guests.familyId })
    .from(guests)
    .all();
  const ada = rows.find((g) => g.firstName === "Ada")!;
  const bo = rows.find((g) => g.firstName === "Bo")!;
  return { db, ada, bo };
}

async function ok<A, E>(db: TestDb, effect: Effect.Effect<A, E, DbService>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provideService(DbService, db)));
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${Cause.pretty(exit.cause)}`);
  return exit.value;
}

/** Writes change rows the way the RSVP route does: one statement, committed. */
async function record(
  db: TestDb,
  familyId: string,
  changes: { guestId: string; eventId: string | null; kind: "reply_new" | "reply_edited" }[],
  at = new Date(),
) {
  const statement = buildRecordStatement(
    db,
    { weddingId: BOOTSTRAP_WEDDING_ID, familyId, changes },
    at,
  );
  if (statement) await commitBatch(db, [statement]);
}

const reply = (
  guestId: string,
  eventId: string,
  status: "attending" | "declined" | "maybe",
  dietary = "",
  dietaryPresets: readonly ("vegetarian" | "nuts" | "halal")[] = [],
) => ({ guestId, eventId, status, dietary, dietaryPresets });

describe("classifyRsvpChanges", () => {
  const prior = (entries: [string, string, PriorReply][]) =>
    new Map(entries.map(([g, e, p]) => [pairKey(g, e), p]));

  it("calls a pair with no stored reply new", () => {
    expect(classifyRsvpChanges(new Map(), [reply("g1", "e1", "attending")])).toEqual([
      { guestId: "g1", eventId: "e1", kind: "reply_new" },
    ]);
  });

  it("calls a changed status an edit", () => {
    const before = prior([["g1", "e1", { status: "maybe", dietary: "", dietaryPresets: "" }]]);
    expect(classifyRsvpChanges(before, [reply("g1", "e1", "attending")])).toEqual([
      { guestId: "g1", eventId: "e1", kind: "reply_edited" },
    ]);
  });

  it("calls changed dietary text an edit", () => {
    const before = prior([["g1", "e1", { status: "attending", dietary: "", dietaryPresets: "" }]]);
    expect(classifyRsvpChanges(before, [reply("g1", "e1", "attending", "no nuts")])).toEqual([
      { guestId: "g1", eventId: "e1", kind: "reply_edited" },
    ]);
  });

  it("calls changed dietary picks an edit, whatever order they arrive in", () => {
    const before = prior([
      ["g1", "e1", { status: "attending", dietary: "", dietaryPresets: "vegetarian,nuts" }],
    ]);
    expect(
      classifyRsvpChanges(before, [reply("g1", "e1", "attending", "", ["nuts", "vegetarian"])]),
    ).toEqual([]);
    expect(
      classifyRsvpChanges(before, [reply("g1", "e1", "attending", "", ["vegetarian"])]),
    ).toEqual([{ guestId: "g1", eventId: "e1", kind: "reply_edited" }]);
  });

  it("logs nothing for a re-submit that changes nothing", () => {
    const before = prior([
      ["g1", "e1", { status: "declined", dietary: "x", dietaryPresets: "halal" }],
    ]);
    expect(classifyRsvpChanges(before, [reply("g1", "e1", "declined", "x", ["halal"])])).toEqual(
      [],
    );
  });

  it("classifies a pair named twice in one body once, from its last entry", () => {
    const before = prior([["g1", "e1", { status: "attending", dietary: "", dietaryPresets: "" }]]);
    expect(
      classifyRsvpChanges(before, [
        reply("g1", "e1", "declined"),
        reply("g2", "e1", "attending"),
        reply("g1", "e1", "attending"),
      ]),
    ).toEqual([{ guestId: "g2", eventId: "e1", kind: "reply_new" }]);
  });
});

describe("buildRecordStatement", () => {
  it("returns nothing to run for no changes", () => {
    const { db, ada } = fixture();
    expect(
      buildRecordStatement(
        db,
        { weddingId: BOOTSTRAP_WEDDING_ID, familyId: ada.familyId, changes: [] },
        new Date(),
      ),
    ).toBeNull();
  });

  it("writes every change, plus-one kinds with no event, in one statement", async () => {
    const { db, ada } = fixture();
    const at = new Date("2026-09-20T10:00:00Z");
    const statement = buildRecordStatement(
      db,
      {
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: ada.familyId,
        changes: [
          { guestId: ada.id, eventId: HINDU, kind: "reply_new" },
          { guestId: ada.id, eventId: null, kind: "plus_one_added" },
        ],
      },
      at,
    );
    expect(statement).not.toBeNull();
    await commitBatch(db, [statement!]);
    const rows = db.select().from(rsvpChanges).orderBy(asc(rsvpChanges.seq)).all();
    expect(rows).toEqual([
      {
        seq: rows[0]!.seq,
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: ada.familyId,
        guestId: ada.id,
        eventId: HINDU,
        kind: "reply_new",
        createdAt: new Date("2026-09-20T10:00:00Z"),
      },
      {
        seq: rows[0]!.seq + 1,
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: ada.familyId,
        guestId: ada.id,
        eventId: null,
        kind: "plus_one_added",
        createdAt: new Date("2026-09-20T10:00:00Z"),
      },
    ]);
  });

  it("binds the whole change set as one parameter, so 200 rows stay under D1's cap", () => {
    const { db, ada } = fixture();
    const changes = Array.from({ length: 200 }, (_, i) => ({
      guestId: `${ada.id}-${i}`,
      eventId: HINDU,
      kind: "reply_new" as const,
    }));
    const statement = buildRecordStatement(
      db,
      { weddingId: BOOTSTRAP_WEDDING_ID, familyId: ada.familyId, changes },
      new Date(),
    ) as unknown as { toSQL(): { params: unknown[] } };
    expect(statement.toSQL().params.length).toBeLessThan(10);
  });
});

describe("summariseUnseen", () => {
  const row = (
    seq: number,
    familyId: string,
    guestId: string,
    eventId: string | null,
    kind: "reply_new" | "reply_edited" | "plus_one_added",
  ) => ({
    seq,
    familyId,
    familyName: familyId.toUpperCase(),
    guestId,
    eventId,
    kind,
    createdAt: new Date(seq * 1000),
  });

  it("is empty with nothing to mark when nothing is unseen", () => {
    expect(summariseUnseen([], 5, 500)).toEqual({
      markSeq: 0,
      households: 0,
      truncated: false,
      items: [],
      rows: [],
    });
  });

  it("folds rows into households, newest first, kinds in a fixed order", () => {
    const summary = summariseUnseen(
      [
        row(9, "fam_b", "g3", "e1", "reply_edited"),
        row(8, "fam_a", "g1", null, "plus_one_added"),
        row(7, "fam_a", "g1", "e1", "reply_new"),
        row(6, "fam_b", "g3", "e1", "reply_new"),
        row(5, "fam_a", "g2", "e2", "reply_new"),
      ],
      5,
      500,
    );
    expect(summary.markSeq).toBe(9);
    expect(summary.households).toBe(2);
    expect(summary.items).toEqual([
      {
        familyId: "fam_b",
        familyName: "FAM_B",
        kinds: ["reply_new", "reply_edited"],
        at: new Date(9000),
      },
      {
        familyId: "fam_a",
        familyName: "FAM_A",
        kinds: ["reply_new", "plus_one_added"],
        at: new Date(8000),
      },
    ]);
    expect(summary.rows).toEqual([
      { guestId: "g3", eventId: "e1" },
      { guestId: "g1", eventId: null },
      { guestId: "g1", eventId: "e1" },
      { guestId: "g2", eventId: "e2" },
    ]);
  });

  it("lists at most the item limit, and flags a read that hit the row limit", () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      row(10 - i, `fam_${i}`, `g${i}`, "e1", "reply_new"),
    );
    const summary = summariseUnseen(rows, 2, 3);
    expect(summary.items.map((i) => i.familyId)).toEqual(["fam_0", "fam_1"]);
    expect(summary.truncated).toBe(true);
    expect(summary.households).toBe(3);
    expect(summary.rows).toHaveLength(3);
    expect(summary.markSeq).toBe(10);
  });
});

describe("rsvpChangeService.feed", () => {
  it("shows only changes past this organiser's own marker", async () => {
    const { db, ada, bo } = fixture();
    await record(db, ada.familyId, [{ guestId: ada.id, eventId: HINDU, kind: "reply_new" }]);
    const first = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(first.households).toBe(1);
    expect(first.digestEnabled).toBe(true);

    await ok(db, rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, OWNER, first.markSeq));
    await record(db, bo.familyId, [{ guestId: bo.id, eventId: RECEPTION, kind: "reply_edited" }]);

    const owner = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(owner.items.map((i) => i.familyId)).toEqual([bo.familyId]);
    expect(owner.rows).toEqual([{ guestId: bo.id, eventId: RECEPTION }]);

    // The editor has marked nothing, so both households are still new to them.
    const editor = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, EDITOR));
    expect(editor.households).toBe(2);
  });

  it("names the household from its current row", async () => {
    const { db, ada } = fixture();
    await record(db, ada.familyId, [{ guestId: ada.id, eventId: HINDU, kind: "reply_new" }]);
    const [family] = db
      .select({ familyName: families.familyName })
      .from(families)
      .where(eq(families.id, ada.familyId))
      .all();
    const feed = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(feed.items[0]!.familyName).toBe(family!.familyName);
  });

  it("never shows another wedding's changes", async () => {
    const { db, ada } = fixture();
    const now = new Date();
    db.insert(weddings)
      .values({
        id: "wed_elsewhere",
        slug: "elsewhere",
        displayName: "Elsewhere",
        ownerOsnProfileId: OWNER,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await record(db, ada.familyId, [{ guestId: ada.id, eventId: HINDU, kind: "reply_new" }]);
    const feed = await ok(db, rsvpChangeService.feed("wed_elsewhere", OWNER));
    expect(feed.households).toBe(0);
    expect(feed.markSeq).toBe(0);
  });

  it("reads through the wedding index, ranging on seq", () => {
    const { db } = fixture();
    const { sql, params } = buildUnseenQuery(db, BOOTSTRAP_WEDDING_ID, OWNER).toSQL();
    const plan = db.$client
      .query<{ detail: string }, never[]>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(params as never[]))
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toMatch(
      /rsvp_changes USING INDEX rsvp_changes_wedding_idx \(wedding_id=\? AND rowid>\?\)/,
    );
    expect(UNSEEN_ROW_LIMIT).toBe(500);
  });
});

describe("rsvpChangeService.markSeen", () => {
  it("never moves the marker past the wedding's newest change", async () => {
    const { db, ada } = fixture();
    await record(db, ada.familyId, [{ guestId: ada.id, eventId: HINDU, kind: "reply_new" }]);
    const [newest] = db.select({ seq: rsvpChanges.seq }).from(rsvpChanges).all();
    const seen = await ok(db, rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, OWNER, 1_000_000));
    expect(seen).toBe(newest!.seq);

    await record(db, ada.familyId, [{ guestId: ada.id, eventId: RECEPTION, kind: "reply_new" }]);
    const feed = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(feed.rows).toEqual([{ guestId: ada.id, eventId: RECEPTION }]);
  });

  it("never moves the marker backwards", async () => {
    const { db, ada } = fixture();
    await record(db, ada.familyId, [
      { guestId: ada.id, eventId: HINDU, kind: "reply_new" },
      { guestId: ada.id, eventId: RECEPTION, kind: "reply_new" },
    ]);
    const feed = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER));
    await ok(db, rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, OWNER, feed.markSeq));
    const again = await ok(db, rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, OWNER, 0));
    expect(again).toBe(feed.markSeq);
  });
});

describe("rsvpChangeService.setDigest", () => {
  const notices = (db: TestDb, profile: string) =>
    db
      .select()
      .from(hostRsvpNotices)
      .where(
        and(
          eq(hostRsvpNotices.weddingId, BOOTSTRAP_WEDDING_ID),
          eq(hostRsvpNotices.osnProfileId, profile),
        ),
      )
      .all()[0];

  it("turns the digest off and on for one organiser only", async () => {
    const { db } = fixture();
    await ok(db, rsvpChangeService.setDigest(BOOTSTRAP_WEDDING_ID, EDITOR, false));
    expect((await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, EDITOR))).digestEnabled).toBe(
      false,
    );
    expect((await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER))).digestEnabled).toBe(
      true,
    );
    await ok(db, rsvpChangeService.setDigest(BOOTSTRAP_WEDDING_ID, EDITOR, true));
    expect(notices(db, EDITOR)?.digestEnabled).toBe(true);
  });

  it("starts a re-enabled digest after the changes made while it was off", async () => {
    const { db, ada } = fixture();
    await ok(db, rsvpChangeService.setDigest(BOOTSTRAP_WEDDING_ID, EDITOR, false));
    await record(db, ada.familyId, [{ guestId: ada.id, eventId: HINDU, kind: "reply_new" }]);
    const [newest] = db.select({ seq: rsvpChanges.seq }).from(rsvpChanges).all();
    await ok(db, rsvpChangeService.setDigest(BOOTSTRAP_WEDDING_ID, EDITOR, true));
    expect(notices(db, EDITOR)?.digestSeq).toBe(newest!.seq);
  });

  it("leaves a digest that was already on where it was", async () => {
    const { db, ada } = fixture();
    await record(db, ada.familyId, [{ guestId: ada.id, eventId: HINDU, kind: "reply_new" }]);
    await ok(db, rsvpChangeService.setDigest(BOOTSTRAP_WEDDING_ID, EDITOR, true));
    expect(notices(db, EDITOR)?.digestSeq).toBe(0);
  });
});

describe("rsvpChangeService.sweepExpired", () => {
  it("deletes rows older than the retention window and nothing newer", async () => {
    const { db, ada } = fixture();
    const now = new Date("2026-09-27T04:00:00Z");
    const old = new Date(now.getTime() - RSVP_CHANGE_RETENTION_MS - 1000);
    const fresh = new Date(now.getTime() - RSVP_CHANGE_RETENTION_MS + 60_000);
    await record(db, ada.familyId, [{ guestId: ada.id, eventId: HINDU, kind: "reply_new" }], old);
    await record(
      db,
      ada.familyId,
      [{ guestId: ada.id, eventId: RECEPTION, kind: "reply_new" }],
      fresh,
    );
    const deleted = await ok(db, rsvpChangeService.sweepExpired(now));
    expect(deleted).toBe(1);
    expect(db.select({ eventId: rsvpChanges.eventId }).from(rsvpChanges).all()).toEqual([
      { eventId: RECEPTION },
    ]);
  });
});

describe("rsvp_changes cascade", () => {
  it("goes with its household", async () => {
    const { db, ada, bo } = fixture();
    await record(db, ada.familyId, [{ guestId: ada.id, eventId: HINDU, kind: "reply_new" }]);
    await record(db, bo.familyId, [{ guestId: bo.id, eventId: HINDU, kind: "reply_new" }]);
    db.delete(families).where(eq(families.id, ada.familyId)).run();
    expect(db.select({ familyId: rsvpChanges.familyId }).from(rsvpChanges).all()).toEqual([
      { familyId: bo.familyId },
    ]);
  });
});

describe("typed failures", () => {
  const flip = <A, E>(db: TestDb, effect: Effect.Effect<A, E, DbService>) =>
    Effect.runPromise(effect.pipe(Effect.flip, Effect.provideService(DbService, db)));

  it("fails markSeen, setDigest and sweepExpired as RsvpChangeError, never a defect", async () => {
    const { db } = fixture();
    db.run(sql`DROP TABLE host_rsvp_notices`);
    expect(
      await flip(db, rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, OWNER, 1)),
    ).toMatchObject({ _tag: "RsvpChangeError", op: "seen" });
    expect(
      await flip(db, rsvpChangeService.setDigest(BOOTSTRAP_WEDDING_ID, OWNER, false)),
    ).toMatchObject({ _tag: "RsvpChangeError", op: "digest" });

    db.run(sql`DROP TABLE rsvp_changes`);
    const before = await counterValue(CIRE_METRICS.rsvpChangeSwept, { result: "error" });
    expect(await flip(db, rsvpChangeService.sweepExpired(new Date()))).toMatchObject({
      _tag: "RsvpChangeError",
      op: "sweep",
    });
    expect(await counterValue(CIRE_METRICS.rsvpChangeSwept, { result: "error" })).toBe(before + 1);
  });

  it("counts the rows a sweep deletes", async () => {
    const { db, ada } = fixture();
    const now = new Date("2026-09-27T04:00:00Z");
    const old = new Date(now.getTime() - RSVP_CHANGE_RETENTION_MS - 1000);
    await record(
      db,
      ada.familyId,
      [
        { guestId: ada.id, eventId: HINDU, kind: "reply_new" },
        { guestId: ada.id, eventId: RECEPTION, kind: "reply_new" },
      ],
      old,
    );
    const before = await counterValue(CIRE_METRICS.rsvpChangeSwept, { result: "ok" });
    await ok(db, rsvpChangeService.sweepExpired(now));
    expect(await counterValue(CIRE_METRICS.rsvpChangeSwept, { result: "ok" })).toBe(before + 2);
  });
});

describe("markSeen on a wedding with no changes", () => {
  it("stores 0 whatever is sent", async () => {
    const { db } = fixture();
    expect(await ok(db, rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, OWNER, 42))).toBe(0);
  });
});

describe("the feed's row limit", () => {
  it("reads exactly the limit without calling it truncated, and one more as truncated", async () => {
    const { db, ada } = fixture();
    const changes = Array.from({ length: UNSEEN_ROW_LIMIT }, (_, i) => ({
      guestId: `${ada.id}-${i}`,
      eventId: HINDU,
      kind: "reply_new" as const,
    }));
    await record(db, ada.familyId, changes);
    const full = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(full.truncated).toBe(false);
    expect(full.rows).toHaveLength(UNSEEN_ROW_LIMIT);

    await record(db, ada.familyId, [{ guestId: ada.id, eventId: RECEPTION, kind: "reply_new" }]);
    const over = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(over.truncated).toBe(true);
    expect(over.rows).toHaveLength(UNSEEN_ROW_LIMIT);
    // The newest change is the one kept, and it is the marker.
    expect(over.rows[0]).toEqual({ guestId: ada.id, eventId: RECEPTION });
  });
});
