import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families, guests, hostRsvpNotices, rsvpChanges } from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { and, asc, eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import { commitBatch, DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import {
  buildRecordStatement,
  buildUnseenHouseholdsQuery,
  buildUnseenPairsQuery,
  classifyRsvpChanges,
  FEED_ITEM_LIMIT,
  pairKey,
  RSVP_CHANGE_RETENTION_MS,
  rsvpChangeService,
  summariseHouseholds,
  summarisePairs,
  UNSEEN_PAIR_LIMIT,
  UNSEEN_SCAN_LIMIT,
  type PriorReply,
} from "../../src/services/rsvp-changes";
import { counterValue } from "../test-helpers/metrics-harness";
import { insertWedding } from "../test-helpers/wedding";

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
  changes: {
    guestId: string;
    eventId: string | null;
    kind: "reply_new" | "reply_edited" | "plus_one_added";
  }[],
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
        actorGuestId: ada.id,
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
        actorGuestId: ada.id,
      },
      {
        seq: rows[0]!.seq + 1,
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: ada.familyId,
        guestId: ada.id,
        eventId: null,
        kind: "plus_one_added",
        createdAt: new Date("2026-09-20T10:00:00Z"),
        actorGuestId: ada.id,
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

describe("summariseHouseholds", () => {
  const group = (
    familyId: string,
    kind: "reply_new" | "reply_edited" | "plus_one_added",
    last: number,
    extra: { households?: number; scanned?: number } = {},
  ) => ({
    familyId,
    familyName: familyId.toUpperCase(),
    kind,
    last,
    at: last * 10,
    households: extra.households ?? 2,
    scanned: extra.scanned ?? 5,
  });

  it("is empty when nothing is unseen", () => {
    expect(summariseHouseholds([])).toEqual({ households: 0, truncated: false, items: [] });
  });

  it("folds groups into households, newest first, kinds in a fixed order", () => {
    const summary = summariseHouseholds([
      group("fam_a", "plus_one_added", 8),
      group("fam_b", "reply_edited", 9),
      group("fam_a", "reply_new", 7),
      group("fam_b", "reply_new", 6),
    ]);
    expect(summary).toEqual({
      households: 2,
      truncated: false,
      items: [
        {
          familyId: "fam_b",
          familyName: "FAM_B",
          kinds: ["reply_new", "reply_edited"],
          at: new Date(90_000),
        },
        {
          familyId: "fam_a",
          familyName: "FAM_A",
          kinds: ["reply_new", "plus_one_added"],
          at: new Date(80_000),
        },
      ],
    });
  });

  it("calls the count a floor only past the scan limit", () => {
    expect(
      summariseHouseholds([group("fam_a", "reply_new", 1, { scanned: UNSEEN_SCAN_LIMIT })])
        .truncated,
    ).toBe(false);
    expect(
      summariseHouseholds([group("fam_a", "reply_new", 1, { scanned: UNSEEN_SCAN_LIMIT + 1 })])
        .truncated,
    ).toBe(true);
  });
});

describe("summarisePairs", () => {
  const pair = (guestId: string, first: number, last: number) => ({
    guestId,
    eventId: "e1",
    first,
    last,
  });

  it("marks nothing when nothing is unseen", () => {
    expect(summarisePairs([], 3)).toEqual({ markSeq: 0, rows: [] });
  });

  it("marks up to the newest change it read when every pair is shown", () => {
    expect(summarisePairs([pair("g1", 4, 12), pair("g2", 5, 6)], 3)).toEqual({
      markSeq: 12,
      rows: [
        { guestId: "g1", eventId: "e1" },
        { guestId: "g2", eventId: "e1" },
      ],
    });
  });

  it("marks up to the newest change when exactly the limit is shown", () => {
    const summary = summarisePairs([pair("g1", 4, 40), pair("g2", 5, 6)], 2);
    expect(summary.rows).toHaveLength(2);
    expect(summary.markSeq).toBe(40);
  });

  it("stops the marker just below the first pair left out", () => {
    const summary = summarisePairs([pair("g1", 4, 40), pair("g2", 5, 6), pair("g3", 9, 9)], 2);
    expect(summary.rows.map((r) => r.guestId)).toEqual(["g1", "g2"]);
    expect(summary.markSeq).toBe(8);
  });
});

describe("rsvpChangeService.feed", () => {
  it("shows only changes past this organiser's own marker", async () => {
    const { db, ada, bo } = fixture();
    await record(db, ada.familyId, [{ guestId: ada.id, eventId: HINDU, kind: "reply_new" }]);
    const first = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(first.households).toBe(1);

    const table = await ok(db, rsvpChangeService.unseenRows(BOOTSTRAP_WEDDING_ID, OWNER));
    await ok(db, rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, OWNER, table.markSeq));
    await record(db, bo.familyId, [{ guestId: bo.id, eventId: RECEPTION, kind: "reply_edited" }]);

    const owner = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(owner.items.map((i) => i.familyId)).toEqual([bo.familyId]);
    expect((await ok(db, rsvpChangeService.unseenRows(BOOTSTRAP_WEDDING_ID, OWNER))).rows).toEqual([
      { guestId: bo.id, eventId: RECEPTION },
    ]);

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
    insertWedding(db, {
      id: "wed_elsewhere",
      slug: "elsewhere",
      displayName: "Elsewhere",
      createdAt: now,
      updatedAt: now,
      owners: [OWNER],
    });
    await record(db, ada.familyId, [{ guestId: ada.id, eventId: HINDU, kind: "reply_new" }]);
    const feed = await ok(db, rsvpChangeService.feed("wed_elsewhere", OWNER));
    expect(feed.households).toBe(0);
    expect(await ok(db, rsvpChangeService.unseenRows("wed_elsewhere", OWNER))).toEqual({
      markSeq: 0,
      rows: [],
    });
  });

  it("reads each window once, through the wedding index, ranging on seq", () => {
    const { db } = fixture();
    for (const build of [buildUnseenHouseholdsQuery, buildUnseenPairsQuery]) {
      const { sql: text, params } = build(db, BOOTSTRAP_WEDDING_ID, OWNER).toSQL();
      const lines = db.$client
        .query<{ detail: string }, never[]>(`EXPLAIN QUERY PLAN ${text}`)
        .all(...(params as never[]))
        .map((r) => r.detail)
        .filter((detail) => /\b(SEARCH|SCAN) rsvp_changes\b/.test(detail));
      expect(lines).toEqual([
        expect.stringMatching(
          /^SEARCH rsvp_changes USING INDEX rsvp_changes_wedding_idx \(wedding_id=\? AND rowid>\?\)$/,
        ),
      ]);
    }
    expect(UNSEEN_SCAN_LIMIT).toBe(5000);
    expect(UNSEEN_PAIR_LIMIT).toBe(500);
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
    const table = await ok(db, rsvpChangeService.unseenRows(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(table.rows).toEqual([{ guestId: ada.id, eventId: RECEPTION }]);
  });

  it("never moves the marker backwards", async () => {
    const { db, ada } = fixture();
    await record(db, ada.familyId, [
      { guestId: ada.id, eventId: HINDU, kind: "reply_new" },
      { guestId: ada.id, eventId: RECEPTION, kind: "reply_new" },
    ]);
    const table = await ok(db, rsvpChangeService.unseenRows(BOOTSTRAP_WEDDING_ID, OWNER));
    await ok(db, rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, OWNER, table.markSeq));
    const again = await ok(db, rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, OWNER, 0));
    expect(again).toBe(table.markSeq);
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
    expect(notices(db, EDITOR)?.digestEnabled).toBe(false);
    // The owner has no row of their own, which reads as on.
    expect(notices(db, OWNER)?.digestEnabled ?? true).toBe(true);
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

  it("fails both feed reads as RsvpChangeError, never a defect", async () => {
    const { db } = fixture();
    db.run(sql`DROP TABLE rsvp_changes`);
    expect(await flip(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER))).toMatchObject({
      _tag: "RsvpChangeError",
      op: "feed",
    });
    expect(await flip(db, rsvpChangeService.unseenRows(BOOTSTRAP_WEDDING_ID, OWNER))).toMatchObject(
      { _tag: "RsvpChangeError", op: "feed" },
    );
  });

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

describe("the feed's limits", () => {
  it("calls exactly the scan limit whole, and one more row a floor", async () => {
    const { db, ada } = fixture();
    const changes = Array.from({ length: UNSEEN_SCAN_LIMIT }, (_, i) => ({
      guestId: `${ada.id}-${i % 10}`,
      eventId: HINDU,
      kind: "reply_edited" as const,
    }));
    await record(db, ada.familyId, changes);
    const full = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(full).toMatchObject({ households: 1, truncated: false });

    await record(db, ada.familyId, [{ guestId: ada.id, eventId: RECEPTION, kind: "reply_new" }]);
    const over = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(over).toMatchObject({ households: 1, truncated: true });
  });

  it("badges the oldest pairs first, and marks seen only what it badged", async () => {
    const { db, ada, bo } = fixture();
    // Bo's household changes first, then Ada's floods more pairs than one
    // table visit shows.
    await record(db, bo.familyId, [{ guestId: bo.id, eventId: HINDU, kind: "reply_new" }]);
    const flood = Array.from({ length: UNSEEN_PAIR_LIMIT + 100 }, (_, i) => ({
      guestId: `${ada.id}-${i}`,
      eventId: HINDU,
      kind: "reply_new" as const,
    }));
    await record(db, ada.familyId, flood);

    const first = await ok(db, rsvpChangeService.unseenRows(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(first.rows).toHaveLength(UNSEEN_PAIR_LIMIT);
    expect(first.rows[0]).toEqual({ guestId: bo.id, eventId: HINDU });
    await ok(db, rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, OWNER, first.markSeq));

    // The next visit badges exactly the pairs the first one left out.
    const second = await ok(db, rsvpChangeService.unseenRows(BOOTSTRAP_WEDDING_ID, OWNER));
    const shown = new Set([...first.rows, ...second.rows].map((r) => r.guestId));
    expect(second.rows).toHaveLength(101);
    expect(shown.size).toBe(UNSEEN_PAIR_LIMIT + 101);
    await ok(db, rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, OWNER, second.markSeq));
    expect(await ok(db, rsvpChangeService.unseenRows(BOOTSTRAP_WEDDING_ID, OWNER))).toEqual({
      markSeq: 0,
      rows: [],
    });
  });

  it("does not let one household's repeated edits crowd another out of the card", async () => {
    const { db, ada, bo } = fixture();
    await record(db, bo.familyId, [{ guestId: bo.id, eventId: HINDU, kind: "reply_new" }]);
    // Twenty submits of the same pairs: many rows, few pairs.
    for (let i = 0; i < 20; i++) {
      await record(
        db,
        ada.familyId,
        Array.from({ length: 50 }, (_, j) => ({
          guestId: `${ada.id}-${j}`,
          eventId: HINDU,
          kind: "reply_edited" as const,
        })),
      );
    }
    const feed = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(feed.households).toBe(2);
    expect(feed.items.map((i) => i.familyId)).toEqual([ada.familyId, bo.familyId]);
    const table = await ok(db, rsvpChangeService.unseenRows(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(table.rows).toHaveLength(51);
  });

  it("names only the five households with the newest change, and counts them all", async () => {
    const { db } = fixture();
    const now = new Date();
    for (let i = 0; i < FEED_ITEM_LIMIT + 2; i++) {
      db.insert(families)
        .values({
          id: `fam_n${i}`,
          weddingId: BOOTSTRAP_WEDDING_ID,
          publicId: `NEWEST-${i}`,
          familyName: `N${i}`,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await record(db, `fam_n${i}`, [{ guestId: `g_n${i}`, eventId: HINDU, kind: "reply_new" }]);
    }
    const feed = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(feed.households).toBe(FEED_ITEM_LIMIT + 2);
    expect(feed.items.map((i) => i.familyId)).toEqual([
      "fam_n6",
      "fam_n5",
      "fam_n4",
      "fam_n3",
      "fam_n2",
    ]);
  });

  it("marks seen only the window it read when one pair fills it", async () => {
    const { db, ada, bo } = fixture();
    // More rows than one read takes, all on ten pairs, then a new pair.
    for (let round = 0; round < Math.ceil((UNSEEN_SCAN_LIMIT + 10) / 200); round++) {
      await record(
        db,
        ada.familyId,
        Array.from({ length: 200 }, (_, i) => ({
          guestId: `${ada.id}-${i % 10}`,
          eventId: HINDU,
          kind: "reply_edited" as const,
        })),
      );
    }
    await record(db, bo.familyId, [{ guestId: bo.id, eventId: HINDU, kind: "reply_new" }]);
    const [boRow] = db
      .select({ seq: rsvpChanges.seq })
      .from(rsvpChanges)
      .where(eq(rsvpChanges.guestId, bo.id))
      .all();

    const first = await ok(db, rsvpChangeService.unseenRows(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(first.rows).toHaveLength(10);
    expect(first.markSeq).toBeLessThan(boRow!.seq);
    await ok(db, rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, OWNER, first.markSeq));

    const later = new Set<string>();
    for (let visit = 0; visit < 3; visit++) {
      const next = await ok(db, rsvpChangeService.unseenRows(BOOTSTRAP_WEDDING_ID, OWNER));
      for (const row of next.rows) later.add(row.guestId);
      await ok(db, rsvpChangeService.markSeen(BOOTSTRAP_WEDDING_ID, OWNER, next.markSeq));
    }
    expect(later.has(bo.id)).toBe(true);
  });

  it("dates each household's latest change from the stored time", async () => {
    const { db, ada } = fixture();
    const at = new Date("2026-09-20T10:00:00Z");
    await record(db, ada.familyId, [{ guestId: ada.id, eventId: HINDU, kind: "reply_new" }], at);
    const feed = await ok(db, rsvpChangeService.feed(BOOTSTRAP_WEDDING_ID, OWNER));
    expect(feed.items[0]!.at).toEqual(at);
  });
});
