import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, weddingFaqs, weddingInviteCustomisations, weddings } from "@cire/db";
import { asc, eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { FAQ_LIMITS } from "../../src/schemas/invite-faq";
import { FaqLimitReached, FaqNotInWedding, inviteFaqService } from "../../src/services/invite-faq";

const OTHER = "wed_other";

function db0() {
  const db = createDb(":memory:");
  seedDb(db);
  db.insert(weddings)
    .values({
      id: OTHER,
      slug: "other",
      displayName: "Other",
      ownerOsnProfileId: "usr_bob",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return db;
}

type TestDb = ReturnType<typeof db0>;

const run = <A, E>(db: TestDb, eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromiseExit(eff.pipe(Effect.provideService(DbService, db)));

async function ok<A, E>(db: TestDb, eff: Effect.Effect<A, E, DbService>): Promise<A> {
  const exit = await run(db, eff);
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${Cause.pretty(exit.cause)}`);
  return exit.value;
}

function failureOf<A, E>(exit: Exit.Exit<A, E>): E | undefined {
  if (!Exit.isFailure(exit)) return undefined;
  return Option.getOrUndefined(Cause.findErrorOption(exit.cause));
}

const add = (
  db: TestDb,
  question: string,
  answer = "An answer.",
  weddingId = BOOTSTRAP_WEDDING_ID,
) => ok(db, inviteFaqService.create(weddingId, { question, answer }));

describe("inviteFaqService", () => {
  it("appends entries in order and lists them for the organiser", async () => {
    const db = db0();
    const a = await add(db, "Is there parking?", "Yes, sixty spaces.");
    const b = await add(db, "Are children invited?");
    expect(a.id).toMatch(/^faq_/);
    expect(a).toEqual({ id: a.id, question: "Is there parking?", answer: "Yes, sixty spaces." });

    const list = await ok(db, inviteFaqService.list(BOOTSTRAP_WEDDING_ID));
    expect(list.map((e) => e.id)).toEqual([a.id, b.id]);

    const stored = db
      .select({ id: weddingFaqs.id, sortOrder: weddingFaqs.sortOrder })
      .from(weddingFaqs)
      .orderBy(asc(weddingFaqs.sortOrder))
      .all();
    expect(stored).toEqual([
      { id: a.id, sortOrder: 0 },
      { id: b.id, sortOrder: 1 },
    ]);
  });

  it("stores the text trimmed", async () => {
    const db = db0();
    const e = await add(db, "  Parking?  ", "\n Yes. \n");
    expect(e.question).toBe("Parking?");
    expect(e.answer).toBe("Yes.");
  });

  it("writes timestamps in epoch seconds, the unit drizzle reads them in", async () => {
    const db = db0();
    const before = Math.floor(Date.now() / 1000);
    const e = await add(db, "When?");
    const after = Math.ceil(Date.now() / 1000);
    const [raw] = db.all<{ created_at: number; updated_at: number }>(
      sql`SELECT created_at, updated_at FROM wedding_faqs WHERE id = ${e.id}`,
    );
    expect(raw!.created_at).toBeGreaterThanOrEqual(before);
    expect(raw!.created_at).toBeLessThanOrEqual(after);
    expect(raw!.updated_at).toBe(raw!.created_at);
    // And drizzle decodes it to today, not to the year 58000.
    const [row] = db.select().from(weddingFaqs).where(eq(weddingFaqs.id, e.id)).all();
    expect(Math.abs(row!.createdAt.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it(`refuses an entry past ${FAQ_LIMITS.maxEntries} and writes nothing`, async () => {
    const db = db0();
    for (let i = 0; i < FAQ_LIMITS.maxEntries; i++) {
      // Sequential on purpose: each create reads the count the last one wrote.
      // eslint-disable-next-line no-await-in-loop
      await add(db, `Question ${i}`);
    }
    const exit = await run(
      db,
      inviteFaqService.create(BOOTSTRAP_WEDDING_ID, { question: "One more", answer: "No." }),
    );
    expect(failureOf(exit)).toBeInstanceOf(FaqLimitReached);
    const count = db
      .select({ n: sql<number>`count(*)` })
      .from(weddingFaqs)
      .where(eq(weddingFaqs.weddingId, BOOTSTRAP_WEDDING_ID))
      .all()[0]!.n;
    expect(count).toBe(FAQ_LIMITS.maxEntries);
  });

  it("counts the cap per wedding", async () => {
    const db = db0();
    for (let i = 0; i < FAQ_LIMITS.maxEntries; i++) {
      // eslint-disable-next-line no-await-in-loop
      await add(db, `Question ${i}`);
    }
    // Another wedding still has room, and starts its own order at 0.
    const other = await add(db, "Other wedding's question", "Yes.", OTHER);
    const [row] = db.select().from(weddingFaqs).where(eq(weddingFaqs.id, other.id)).all();
    expect(row!.sortOrder).toBe(0);
  });

  it("appends after the highest sort_order, not after the count", async () => {
    const db = db0();
    const a = await add(db, "A");
    await add(db, "B");
    await ok(db, inviteFaqService.remove(BOOTSTRAP_WEDDING_ID, a.id));
    const c = await add(db, "C");
    const [row] = db.select().from(weddingFaqs).where(eq(weddingFaqs.id, c.id)).all();
    expect(row!.sortOrder).toBe(2);
  });

  it("updates an entry's question and answer", async () => {
    const db = db0();
    const e = await add(db, "Parking?", "Maybe.");
    const updated = await ok(
      db,
      inviteFaqService.update(BOOTSTRAP_WEDDING_ID, e.id, {
        question: " Is there parking? ",
        answer: "Yes.",
      }),
    );
    expect(updated).toEqual({ id: e.id, question: "Is there parking?", answer: "Yes." });
    expect((await ok(db, inviteFaqService.list(BOOTSTRAP_WEDDING_ID)))[0]).toEqual(updated);
  });

  it("refuses to update or remove another wedding's entry, and leaves it untouched", async () => {
    const db = db0();
    const theirs = await add(db, "Theirs", "Theirs.", OTHER);

    const upd = await run(
      db,
      inviteFaqService.update(BOOTSTRAP_WEDDING_ID, theirs.id, {
        question: "Mine",
        answer: "Mine.",
      }),
    );
    expect(failureOf(upd)).toBeInstanceOf(FaqNotInWedding);

    const del = await run(db, inviteFaqService.remove(BOOTSTRAP_WEDDING_ID, theirs.id));
    expect(failureOf(del)).toBeInstanceOf(FaqNotInWedding);

    expect(await ok(db, inviteFaqService.list(OTHER))).toEqual([theirs]);
  });

  it("fails an unknown id on update and remove", async () => {
    const db = db0();
    const upd = await run(
      db,
      inviteFaqService.update(BOOTSTRAP_WEDDING_ID, "faq_missing", { question: "Q", answer: "A" }),
    );
    expect(failureOf(upd)).toBeInstanceOf(FaqNotInWedding);
    const del = await run(db, inviteFaqService.remove(BOOTSTRAP_WEDDING_ID, "faq_missing"));
    expect(failureOf(del)).toBeInstanceOf(FaqNotInWedding);
  });

  it("stores a new order and ignores another wedding's id in it", async () => {
    const db = db0();
    const a = await add(db, "A");
    const b = await add(db, "B");
    const c = await add(db, "C");
    const theirs = await add(db, "Theirs", "Theirs.", OTHER);

    await ok(db, inviteFaqService.reorder(BOOTSTRAP_WEDDING_ID, [c.id, theirs.id, a.id, b.id]));

    const list = await ok(db, inviteFaqService.list(BOOTSTRAP_WEDDING_ID));
    expect(list.map((e) => e.question)).toEqual(["C", "A", "B"]);
    const [theirRow] = db.select().from(weddingFaqs).where(eq(weddingFaqs.id, theirs.id)).all();
    expect(theirRow!.sortOrder).toBe(0);
  });

  it("writes only the rows whose position changes", async () => {
    const db = db0();
    const a = await add(db, "A");
    const b = await add(db, "B");
    const c = await add(db, "C");
    const changes = () => db.all<{ n: number }>(sql`SELECT total_changes() AS n`)[0]!.n;

    // Swap the last two: `a` keeps position 0 and is not rewritten.
    let before = changes();
    await ok(db, inviteFaqService.reorder(BOOTSTRAP_WEDDING_ID, [a.id, c.id, b.id]));
    expect(changes() - before).toBe(2);

    // The same order again writes nothing.
    before = changes();
    await ok(db, inviteFaqService.reorder(BOOTSTRAP_WEDDING_ID, [a.id, c.id, b.id]));
    expect(changes() - before).toBe(0);
    expect((await ok(db, inviteFaqService.list(BOOTSTRAP_WEDDING_ID))).map((e) => e.id)).toEqual([
      a.id,
      c.id,
      b.id,
    ]);
  });

  it("breaks a sort_order tie by id, so the order is stable", async () => {
    const db = db0();
    const now = new Date();
    db.insert(weddingFaqs)
      .values([
        {
          id: "faq_b",
          weddingId: BOOTSTRAP_WEDDING_ID,
          question: "B",
          answer: "b",
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "faq_a",
          weddingId: BOOTSTRAP_WEDDING_ID,
          question: "A",
          answer: "a",
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    expect((await ok(db, inviteFaqService.list(BOOTSTRAP_WEDDING_ID))).map((e) => e.id)).toEqual([
      "faq_a",
      "faq_b",
    ]);
  });

  describe("listForGuests", () => {
    it("returns the ordered list while the switch is on, and with no customisation row", async () => {
      const db = db0();
      db.delete(weddingInviteCustomisations).run();
      await add(db, "A", "a");
      await add(db, "B", "b");
      const both = [
        { question: "A", answer: "a" },
        { question: "B", answer: "b" },
      ];
      expect(await ok(db, inviteFaqService.listForGuests(BOOTSTRAP_WEDDING_ID))).toEqual(both);

      db.insert(weddingInviteCustomisations)
        .values({ weddingId: BOOTSTRAP_WEDDING_ID, faqVisible: true, updatedAt: new Date() })
        .run();
      expect(await ok(db, inviteFaqService.listForGuests(BOOTSTRAP_WEDDING_ID))).toEqual(both);
    });

    it("returns nothing while the switch is off, and the entries are kept", async () => {
      const db = db0();
      db.delete(weddingInviteCustomisations).run();
      await add(db, "A");
      db.insert(weddingInviteCustomisations)
        .values({ weddingId: BOOTSTRAP_WEDDING_ID, faqVisible: false, updatedAt: new Date() })
        .run();
      expect(await ok(db, inviteFaqService.listForGuests(BOOTSTRAP_WEDDING_ID))).toEqual([]);
      expect(await ok(db, inviteFaqService.list(BOOTSTRAP_WEDDING_ID))).toHaveLength(1);
    });

    it("does not read another wedding's switch", async () => {
      const db = db0();
      db.delete(weddingInviteCustomisations).run();
      await add(db, "A", "a");
      db.insert(weddingInviteCustomisations)
        .values({ weddingId: OTHER, faqVisible: false, updatedAt: new Date() })
        .run();
      expect(await ok(db, inviteFaqService.listForGuests(BOOTSTRAP_WEDDING_ID))).toEqual([
        { question: "A", answer: "a" },
      ]);
    });
  });
});
