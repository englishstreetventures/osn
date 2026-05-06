import { describe, it, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { eq } from "drizzle-orm";
import { events, families, guests, guestEvents, rsvps } from "@cire/db";
import { DbService } from "../db";
import { createDb, seedDb } from "../db/setup";
import { applyImport, diffAgainstDb } from "./import";
import { parseEventsCsv, parseGuestsCsv } from "./spreadsheet";
import type { ParsedEvent, ParsedFamily } from "../schemas/import";

/** Build a fresh in-memory DB layer for each test. */
function freshDbLayer(seed: boolean) {
  return Layer.scoped(
    DbService,
    Effect.sync(() => {
      const db = createDb(":memory:");
      if (seed) seedDb(db);
      return db;
    }),
  );
}

const FOUR_EVENTS_CSV = [
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
  "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,12 Banksia Lane,Bright,Marigold:oklch(76% 0.15 75),,",
  "Sangeet,2026-09-19T18:30:00+10:00,2026-09-19T23:30:00+10:00,Australia/Sydney,Pavilion,1 Grand Drive,Bold,,,",
  "Wedding Ceremony,2026-09-20T16:00:00+10:00,2026-09-20T18:00:00+10:00,Australia/Sydney,Garden,Mrs Macquaries Rd,Formal,Sage:oklch(72% 0.05 128),,",
  "Reception,2026-09-20T19:00:00+10:00,2026-09-21T00:00:00+10:00,Australia/Sydney,Doltone,26 Pirrama Rd,Cocktail,,,",
].join("\n");

const FOUR_FAMILIES_CSV = [
  "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Sangeet,Wedding Ceremony,Reception",
  "1,Sharma,Priya,Sharma,yes,no,yes,yes",
  "2,Wilson,James,Wilson,no,no,yes,yes",
  "2,Wilson,Emma,Wilson,no,no,yes,yes",
  "2,Wilson,Sophie,Wilson,no,no,yes,no",
  "3,Meena,Auntie,Meena,yes,no,yes,no",
  "4,Patel,Dev,Patel,no,no,yes,yes",
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
        yield* applyImport("import-1", plan1);
      }).pipe(Effect.provide(layer)),
    );

    // Second run uses the SAME layer instance? Layer.scoped recreates per use.
    // Use a layer that returns the same db across two runs:
    const sharedDb = createDb(":memory:");
    const sharedLayer = Layer.succeed(DbService, sharedDb);

    await Effect.runPromise(
      Effect.gen(function* () {
        const p1 = yield* diffAgainstDb(ev, fam);
        yield* applyImport("import-1", p1);
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
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Sangeet,Wedding Ceremony,Reception",
      "1,Sharma-Patel,Priya,Sharma,yes,no,yes,yes",
      "2,Wilson,James,Wilson,no,no,yes,yes",
      "2,Wilson,Emma,Wilson,no,no,yes,yes",
      "2,Wilson,Sophie,Wilson,no,no,yes,no",
      "3,Meena,Auntie,Meena,yes,no,yes,no",
      "4,Patel,Dev,Patel,no,no,yes,yes",
    ].join("\n");

    const ev = await Effect.runPromise(parseEventsCsv(FOUR_EVENTS_CSV));
    const fam = (await Effect.runPromise(parseGuestsCsv(renamedCsv, ev))) as ParsedFamily[];

    const plan = await Effect.runPromise(diffAgainstDb(ev, fam).pipe(Effect.provide(sharedLayer)));
    expect(plan.familyRemoves.map((f) => f.familyName)).toContain("Sharma");
    expect(plan.familyCreates.map((f) => f.familyName)).toContain("Sharma-Patel");
  });
});

describe("diff: guest first-name change = remove + create", () => {
  it("first-name change drops + recreates the guest, preserving last-name updates on others", async () => {
    const sharedDb = createDb(":memory:");
    seedDb(sharedDb);
    const sharedLayer = Layer.succeed(DbService, sharedDb);

    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Sangeet,Wedding Ceremony,Reception",
      "1,Sharma,Priya,Sharma-Patel,yes,no,yes,yes",
      "2,Wilson,Jim,Wilson,no,no,yes,yes",
      "2,Wilson,Emma,Wilson,no,no,yes,yes",
      "2,Wilson,Sophie,Wilson,no,no,yes,no",
      "3,Meena,Auntie,Meena,yes,no,yes,no",
      "4,Patel,Dev,Patel,no,no,yes,yes",
    ].join("\n");

    const ev = await Effect.runPromise(parseEventsCsv(FOUR_EVENTS_CSV));
    const fam = (await Effect.runPromise(parseGuestsCsv(csv, ev))) as ParsedFamily[];
    const plan = await Effect.runPromise(diffAgainstDb(ev, fam).pipe(Effect.provide(sharedLayer)));

    // James → Jim: remove + create.
    expect(plan.guestRemoves.map((g) => g.firstName)).toContain("James");
    expect(plan.guestCreates.map((g) => g.firstName)).toContain("Jim");
    // Priya: last-name change only → guestUpdate.
    expect(plan.guestUpdates.find((g) => g.lastName === "Sharma-Patel")).toBeDefined();
  });
});

describe("diff: guestEvent toggles", () => {
  it("removing an event invitation appears as eventLinkRemove", async () => {
    const sharedDb = createDb(":memory:");
    seedDb(sharedDb);
    const sharedLayer = Layer.succeed(DbService, sharedDb);

    const csv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Sangeet,Wedding Ceremony,Reception",
      "1,Sharma,Priya,Sharma,no,no,no,no", // was invited to mehndi/wedding/reception
      "2,Wilson,James,Wilson,no,no,yes,yes",
      "2,Wilson,Emma,Wilson,no,no,yes,yes",
      "2,Wilson,Sophie,Wilson,no,no,yes,no",
      "3,Meena,Auntie,Meena,yes,no,yes,no",
      "4,Patel,Dev,Patel,no,no,yes,yes",
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

    // Add an RSVP for James Wilson (will be renamed → removed).
    const [james] = sharedDb.select().from(guests).where(eq(guests.firstName, "James")).all();
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
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Sangeet,Wedding Ceremony,Reception",
      "1,Sharma,Priya,Sharma,yes,no,yes,yes",
      "2,Wilson,Jim,Wilson,no,no,yes,yes",
      "2,Wilson,Emma,Wilson,no,no,yes,yes",
      "2,Wilson,Sophie,Wilson,no,no,yes,no",
      "3,Meena,Auntie,Meena,yes,no,yes,no",
      "4,Patel,Dev,Patel,no,no,yes,yes",
    ].join("\n");

    const ev = await Effect.runPromise(parseEventsCsv(FOUR_EVENTS_CSV));
    const fam = (await Effect.runPromise(parseGuestsCsv(csv, ev))) as ParsedFamily[];
    const plan = await Effect.runPromise(diffAgainstDb(ev, fam).pipe(Effect.provide(sharedLayer)));

    expect(plan.warnings.length).toBeGreaterThan(0);
    const warning = plan.warnings[0]!;
    expect(warning).toContain("James");
    expect(warning).toContain("attending");
    expect(warning).toContain("vegan");
    // No surnames in warning text:
    expect(warning).not.toContain("Wilson");
  });
});

describe("applyImport: empty-DB insert end-to-end", () => {
  it("populates events, families, guests, and links", async () => {
    const { ev, fam } = await parsedFromCsv();
    const sharedDb = createDb(":memory:");
    const sharedLayer = Layer.succeed(DbService, sharedDb);
    await Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* diffAgainstDb(ev, fam);
        yield* applyImport("imp-1", plan);
      }).pipe(Effect.provide(sharedLayer)),
    );
    expect(sharedDb.select().from(events).all()).toHaveLength(4);
    expect(sharedDb.select().from(families).all()).toHaveLength(4);
    expect(sharedDb.select().from(guests).all()).toHaveLength(6);
    expect(sharedDb.select().from(guestEvents).all().length).toBeGreaterThan(0);
  });
});
