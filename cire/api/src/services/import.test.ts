import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, families, guests, guestEvents, rsvps } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { DbService } from "../db";
import { createDb, seedBootstrapWedding, seedDb } from "../db/setup";
import type { ParsedEvent, ParsedFamily } from "../schemas/import";
import { applyImport, diffAgainstDb } from "./import";
import { parseEventsCsv, parseGuestsCsv } from "./spreadsheet";

/** Build a fresh in-memory DB layer for each test. */
function freshDbLayer(seed: boolean) {
  return Layer.scoped(
    DbService,
    Effect.sync(() => {
      const db = createDb(":memory:");
      if (seed) seedDb(db);
      else seedBootstrapWedding(db);
      return db;
    }),
  );
}

const FOUR_EVENTS_CSV = [
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
  "Catholic Ceremony,2026-10-31T10:00:00+11:00,2026-10-31T13:00:00+11:00,Australia/Sydney,Example Parish,123 Example St,Semiformal,Blush:oklch(86% 0.05 12),,",
  "Mehendi,2026-11-22T18:00:00+11:00,2026-11-22T23:00:00+11:00,Australia/Sydney,Sample Hall,124 Sample Avenue,Semicasual/Indian,Marigold:oklch(76% 0.15 75),,",
  "Hindu Ceremony,2026-11-25T09:00:00+11:00,2026-11-25T12:00:00+11:00,Australia/Sydney,Example Temple,125 Placeholder Hwy,Formal/Indian Traditional,Terracotta:oklch(58% 0.12 38),,",
  "Reception,2026-11-28T18:00:00+11:00,2026-11-28T23:00:00+11:00,Australia/Sydney,Sample Reception House,126 Example Road,Formal,Midnight:oklch(28% 0.06 268),,",
].join("\n");

const FOUR_FAMILIES_CSV = [
  "Family ID,Family Name,Guest First Name,Guest Last Name,Catholic Ceremony,Mehendi,Hindu Ceremony,Reception",
  "1,Testfamily,Ada,Testfamily,yes,no,yes,yes",
  "2,Sampleton,Bo,Sampleton,no,no,yes,yes",
  "2,Sampleton,Cleo,Sampleton,no,no,yes,yes",
  "2,Sampleton,Dot,Sampleton,no,no,yes,no",
  "3,Exampleton,Nori,Exampleton,yes,no,yes,no",
  "4,Placeholder,Eli,Placeholder,no,no,yes,yes",
].join("\n");

async function parsedFromCsv(): Promise<{ ev: ParsedEvent[]; fam: ParsedFamily[] }> {
  const ev = await Effect.runPromise(parseEventsCsv(FOUR_EVENTS_CSV));
  const fam = await Effect.runPromise(parseGuestsCsv(FOUR_FAMILIES_CSV, ev));
  return { ev, fam: fam as ParsedFamily[] };
}

describe("diffAgainstDb (empty DB)", () => {
  it("creates everything when DB is empty", async () => {
    const { ev, fam } = await parsedFromCsv();
    const layer = freshDbLayer(false);
    const plan = await Effect.runPromise(diffAgainstDb(ev, fam).pipe(Effect.provide(layer)));
    expect(plan.eventCreates).toHaveLength(4);
    expect(plan.eventUpdates).toHaveLength(0);
    expect(plan.eventRemoves).toHaveLength(0);
    expect(plan.familyCreates).toHaveLength(4);
    expect(plan.familyRemoves).toHaveLength(0);
    expect(plan.guestCreates).toHaveLength(6);
    expect(plan.guestRemoves).toHaveLength(0);
  });
});

describe("applyImport + re-diff (idempotent)", () => {
  it("applying twice yields a no-op second plan", async () => {
    const { ev, fam } = await parsedFromCsv();
    const layer = freshDbLayer(false);
    await Effect.runPromise(
      Effect.gen(function* () {
        const plan1 = yield* diffAgainstDb(ev, fam);
        yield* applyImport("import-1", plan1, BOOTSTRAP_WEDDING_ID);
      }).pipe(Effect.provide(layer)),
    );

    // Second run uses the SAME layer instance? Layer.scoped recreates per use.
    // Use a layer that returns the same db across two runs:
    const sharedDb = createDb(":memory:");
    seedBootstrapWedding(sharedDb);
    const sharedLayer = Layer.succeed(DbService, sharedDb);

    await Effect.runPromise(
      Effect.gen(function* () {
        const p1 = yield* diffAgainstDb(ev, fam);
        yield* applyImport("import-1", p1, BOOTSTRAP_WEDDING_ID);
        const p2 = yield* diffAgainstDb(ev, fam);
        expect(p2.eventCreates).toHaveLength(0);
        expect(p2.eventRemoves).toHaveLength(0);
        expect(p2.familyCreates).toHaveLength(0);
        expect(p2.familyRemoves).toHaveLength(0);
        expect(p2.guestCreates).toHaveLength(0);
        expect(p2.guestRemoves).toHaveLength(0);
        expect(p2.eventLinkCreates).toHaveLength(0);
        expect(p2.eventLinkRemoves).toHaveLength(0);
      }).pipe(Effect.provide(sharedLayer)),
    );
  });
});

describe("diff: family rename = remove + create", () => {
  it("renaming a family is treated as remove + create (no public_id preservation)", async () => {
    const sharedDb = createDb(":memory:");
    seedDb(sharedDb);
    const sharedLayer = Layer.succeed(DbService, sharedDb);

    const renamedCsv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Catholic Ceremony,Mehendi,Hindu Ceremony,Reception",
      "1,Testfamily-Placeholder,Ada,Testfamily,yes,no,yes,yes",
      "2,Sampleton,Bo,Sampleton,no,no,yes,yes",
      "2,Sampleton,Cleo,Sampleton,no,no,yes,yes",
      "2,Sampleton,Dot,Sampleton,no,no,yes,no",
      "3,Exampleton,Nori,Exampleton,yes,no,yes,no",
      "4,Placeholder,Eli,Placeholder,no,no,yes,yes",
    ].join("\n");

    const ev = await Effect.runPromise(parseEventsCsv(FOUR_EVENTS_CSV));
    const fam = (await Effect.runPromise(parseGuestsCsv(renamedCsv, ev))) as ParsedFamily[];

    const plan = await Effect.runPromise(diffAgainstDb(ev, fam).pipe(Effect.provide(sharedLayer)));
    expect(plan.familyRemoves.map((f) => f.familyName)).toContain("Testfamily");
    expect(plan.familyCreates.map((f) => f.familyName)).toContain("Testfamily-Placeholder");
  });
});

describe("diff: guest first-name change = remove + create", () => {
  it("first-name change drops + recreates the guest, preserving last-name updates on others", async () => {
    const sharedDb = createDb(":memory:");
    seedDb(sharedDb);
    const sharedLayer = Layer.succeed(DbService, sharedDb);

    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Catholic Ceremony,Mehendi,Hindu Ceremony,Reception",
      "1,Testfamily,Ada,Testfamily-Placeholder,yes,no,yes,yes",
      "2,Sampleton,Jim,Sampleton,no,no,yes,yes",
      "2,Sampleton,Cleo,Sampleton,no,no,yes,yes",
      "2,Sampleton,Dot,Sampleton,no,no,yes,no",
      "3,Exampleton,Nori,Exampleton,yes,no,yes,no",
      "4,Placeholder,Eli,Placeholder,no,no,yes,yes",
    ].join("\n");

    const ev = await Effect.runPromise(parseEventsCsv(FOUR_EVENTS_CSV));
    const fam = (await Effect.runPromise(parseGuestsCsv(csv, ev))) as ParsedFamily[];
    const plan = await Effect.runPromise(diffAgainstDb(ev, fam).pipe(Effect.provide(sharedLayer)));

    // Bo → Jim: remove + create.
    expect(plan.guestRemoves.map((g) => g.firstName)).toContain("Bo");
    expect(plan.guestCreates.map((g) => g.firstName)).toContain("Jim");
    // Ada: last-name change only → guestUpdate.
    expect(plan.guestUpdates.find((g) => g.lastName === "Testfamily-Placeholder")).toBeDefined();
  });
});

describe("diff: guestEvent toggles", () => {
  it("removing an event invitation appears as eventLinkRemove", async () => {
    const sharedDb = createDb(":memory:");
    seedDb(sharedDb);
    const sharedLayer = Layer.succeed(DbService, sharedDb);

    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Catholic Ceremony,Mehendi,Hindu Ceremony,Reception",
      "1,Testfamily,Ada,Testfamily,no,no,no,no", // was invited to catholic/hindu/reception
      "2,Sampleton,Bo,Sampleton,no,no,yes,yes",
      "2,Sampleton,Cleo,Sampleton,no,no,yes,yes",
      "2,Sampleton,Dot,Sampleton,no,no,yes,no",
      "3,Exampleton,Nori,Exampleton,yes,no,yes,no",
      "4,Placeholder,Eli,Placeholder,no,no,yes,yes",
    ].join("\n");

    const ev = await Effect.runPromise(parseEventsCsv(FOUR_EVENTS_CSV));
    const fam = (await Effect.runPromise(parseGuestsCsv(csv, ev))) as ParsedFamily[];
    const plan = await Effect.runPromise(diffAgainstDb(ev, fam).pipe(Effect.provide(sharedLayer)));
    expect(plan.eventLinkRemoves.length).toBeGreaterThan(0);
  });
});

describe("diff: warning when removing a guest with non-default RSVP", () => {
  it("emits a first-name-only warning", async () => {
    const sharedDb = createDb(":memory:");
    seedDb(sharedDb);

    // Add an RSVP for Bo Sampleton (will be renamed → removed).
    const [james] = sharedDb.select().from(guests).where(eq(guests.firstName, "Bo")).all();
    sharedDb
      .insert(rsvps)
      .values({
        id: crypto.randomUUID(),
        guestId: james!.id,
        eventId: "9f7a2c14-1b3d-4e5f-8a01-000000000003",
        status: "attending",
        dietary: "vegan",
        createdAt: new Date(),
      })
      .run();

    const sharedLayer = Layer.succeed(DbService, sharedDb);

    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Catholic Ceremony,Mehendi,Hindu Ceremony,Reception",
      "1,Testfamily,Ada,Testfamily,yes,no,yes,yes",
      "2,Sampleton,Jim,Sampleton,no,no,yes,yes",
      "2,Sampleton,Cleo,Sampleton,no,no,yes,yes",
      "2,Sampleton,Dot,Sampleton,no,no,yes,no",
      "3,Exampleton,Nori,Exampleton,yes,no,yes,no",
      "4,Placeholder,Eli,Placeholder,no,no,yes,yes",
    ].join("\n");

    const ev = await Effect.runPromise(parseEventsCsv(FOUR_EVENTS_CSV));
    const fam = (await Effect.runPromise(parseGuestsCsv(csv, ev))) as ParsedFamily[];
    const plan = await Effect.runPromise(diffAgainstDb(ev, fam).pipe(Effect.provide(sharedLayer)));

    expect(plan.warnings.length).toBeGreaterThan(0);
    const warning = plan.warnings[0]!;
    expect(warning).toContain("Bo");
    expect(warning).toContain("attending");
    expect(warning).toContain("vegan");
    // No surnames in warning text:
    expect(warning).not.toContain("Sampleton");
  });
});

describe("applyImport: empty-DB insert end-to-end", () => {
  it("populates events, families, guests, and links", async () => {
    const { ev, fam } = await parsedFromCsv();
    const sharedDb = createDb(":memory:");
    seedBootstrapWedding(sharedDb);
    const sharedLayer = Layer.succeed(DbService, sharedDb);
    await Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* diffAgainstDb(ev, fam);
        yield* applyImport("imp-1", plan, BOOTSTRAP_WEDDING_ID);
      }).pipe(Effect.provide(sharedLayer)),
    );
    expect(sharedDb.select().from(events).all()).toHaveLength(4);
    expect(sharedDb.select().from(families).all()).toHaveLength(4);
    expect(sharedDb.select().from(guests).all()).toHaveLength(6);
    expect(sharedDb.select().from(guestEvents).all().length).toBeGreaterThan(0);
  });
});
