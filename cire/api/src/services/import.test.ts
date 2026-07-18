import { describe, it, expect } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  families,
  guests,
  guestEvents,
  rsvps,
  weddings,
  weddingEntitlements,
} from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Exit, Layer } from "effect";

import { DbService } from "../db";
import type { Db } from "../db";
import { createDb, seedBootstrapWedding, seedDb } from "../db/setup";
import type { ParsedEvent, ParsedFamily } from "../schemas/import";
import { claimService } from "./claim";
import { entitlementService } from "./entitlements";
import { hostCodeService } from "./host-code";
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

/**
 * Seed a fully-populated second wedding (event + family + guest + link). Its
 * rows must stay invisible to a diff scoped to a different wedding. Names are
 * configurable so tests can probe cross-tenant *name collisions* — the
 * families-join is the only thing keeping same-named rows in separate tenants
 * apart.
 */
function seedOtherWedding(
  db: Db,
  opts: {
    weddingId?: string;
    familyName?: string;
    guestFirstName?: string;
    guestLastName?: string;
    eventName?: string;
  } = {},
): { weddingId: string; eventId: string; familyId: string; guestId: string } {
  const weddingId = opts.weddingId ?? "wed_other";
  const now = new Date();
  db.insert(weddings)
    .values({
      id: weddingId,
      slug: `slug-${weddingId}`,
      displayName: "Other",
      ownerOsnProfileId: "usr_other",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const eventId = crypto.randomUUID();
  db.insert(events)
    .values({
      id: eventId,
      weddingId,
      slug: `evt-${eventId}`,
      name: opts.eventName ?? "Other Party",
      description: "",
      startAt: "2027-01-01T10:00:00+11:00",
      endAt: "2027-01-01T12:00:00+11:00",
      timezone: "Australia/Sydney",
      address: null,
      dressCodeDescription: null,
      dressCodePalette: null,
      pinterestUrl: null,
      mapsUrl: null,
      sortOrder: 0,
    })
    .run();
  const familyId = crypto.randomUUID();
  db.insert(families)
    .values({
      id: familyId,
      weddingId,
      publicId: `PUB-${familyId.slice(0, 8)}`,
      familyName: opts.familyName ?? "Otherfamily",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const guestId = crypto.randomUUID();
  db.insert(guests)
    .values({
      id: guestId,
      familyId,
      firstName: opts.guestFirstName ?? "Zoe",
      lastName: opts.guestLastName ?? "Otherfamily",
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(guestEvents).values({ guestId, eventId }).run();
  return { weddingId, eventId, familyId, guestId };
}

describe("diffAgainstDb (empty DB)", () => {
  it("creates everything when DB is empty", async () => {
    const { ev, fam } = await parsedFromCsv();
    const layer = freshDbLayer(false);
    const plan = await Effect.runPromise(
      diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
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
        const plan1 = yield* diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID);
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
        const p1 = yield* diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID);
        yield* applyImport("import-1", p1, BOOTSTRAP_WEDDING_ID);
        const p2 = yield* diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID);
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

  it("leaves the host preview family + its links untouched on re-import", async () => {
    const { ev, fam } = await parsedFromCsv();
    const db = createDb(":memory:");
    seedBootstrapWedding(db);
    const layer = Layer.succeed(DbService, db);

    await Effect.runPromise(
      Effect.gen(function* () {
        // Populate the wedding, then provision the host preview family.
        const plan = yield* diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID);
        yield* applyImport("import-1", plan, BOOTSTRAP_WEDDING_ID);
        const { publicId } = yield* hostCodeService.ensureForWedding(BOOTSTRAP_WEDDING_ID);

        // The host family is invisible to the diff — never removed, never churned.
        const rediff = yield* diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID);
        expect(rediff.familyRemoves).toHaveLength(0);
        expect(rediff.eventLinkRemoves).toHaveLength(0);

        // Apply the (no-op) re-diff, then confirm the host code still resolves
        // to every event.
        yield* applyImport("import-2", rediff, BOOTSTRAP_WEDDING_ID);
        const claimed = yield* claimService.lookup(publicId);
        expect(claimed.preview).toBe(true);
        expect(claimed.events.length).toBe(ev.length);

        const hostRows = db.select().from(families).where(eq(families.kind, "host")).all();
        expect(hostRows).toHaveLength(1);
        expect(hostRows[0]!.publicId).toBe(publicId);
      }).pipe(Effect.provide(layer)),
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

    const plan = await Effect.runPromise(
      diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(sharedLayer)),
    );
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
    const plan = await Effect.runPromise(
      diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(sharedLayer)),
    );

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
    const plan = await Effect.runPromise(
      diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(sharedLayer)),
    );
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
    const plan = await Effect.runPromise(
      diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(sharedLayer)),
    );

    expect(plan.warnings.length).toBeGreaterThan(0);
    const warning = plan.warnings[0]!;
    expect(warning).toContain("Bo");
    expect(warning).toContain("attending");
    expect(warning).toContain("vegan");
    // No surnames in warning text:
    expect(warning).not.toContain("Sampleton");
  });
});

describe("diff: wedding scoping (multi-tenant isolation)", () => {
  it("ignores another wedding's events/families/guests/links", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db); // empty target wedding (the bootstrap scope)

    // A second, fully-populated wedding whose rows must stay invisible to a
    // bootstrap-scoped diff. Before join-based scoping the unscoped reads would
    // flag every one of these for removal (none appear in the bootstrap sheet)
    // and applyImport would wipe the other tenant.
    const other = seedOtherWedding(db);

    const layer = Layer.succeed(DbService, db);
    const { ev, fam } = await parsedFromCsv();

    const plan = await Effect.runPromise(
      diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    // All creates for the bootstrap scope; zero cross-tenant removals.
    expect(plan.eventCreates).toHaveLength(4);
    expect(plan.eventRemoves).toHaveLength(0);
    expect(plan.familyCreates).toHaveLength(4);
    expect(plan.familyRemoves).toHaveLength(0);
    expect(plan.guestCreates).toHaveLength(6);
    expect(plan.guestRemoves).toHaveLength(0);
    expect(plan.eventLinkRemoves).toHaveLength(0);

    // Apply, then assert the other wedding's rows survived untouched.
    await Effect.runPromise(
      applyImport("imp-scope", plan, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
    expect(db.select().from(events).where(eq(events.id, other.eventId)).all()).toHaveLength(1);
    expect(db.select().from(families).where(eq(families.id, other.familyId)).all()).toHaveLength(1);
    expect(db.select().from(guests).where(eq(guests.id, other.guestId)).all()).toHaveLength(1);
    expect(
      db.select().from(guestEvents).where(eq(guestEvents.guestId, other.guestId)).all(),
    ).toHaveLength(1);
  });

  it("does not match a same-named family/guest/event from another wedding (T-S1)", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db); // empty target wedding

    // The other wedding shares a family name + guest first-name + event name
    // with the bootstrap sheet. The families-join is the only thing keeping
    // these apart — a dropped `WHERE families.weddingId` would let the diff
    // match (or remove) the wrong tenant's rows despite distinct ids.
    const other = seedOtherWedding(db, {
      familyName: "Testfamily",
      guestFirstName: "Ada",
      guestLastName: "Testfamily",
      eventName: "Catholic Ceremony",
    });

    const layer = Layer.succeed(DbService, db);
    const { ev, fam } = await parsedFromCsv();

    const plan = await Effect.runPromise(
      diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    // Bootstrap scope still sees an empty DB → everything is a create; nothing
    // matched the same-named foreign rows into an update/remove.
    expect(plan.eventCreates).toHaveLength(4);
    expect(plan.familyCreates.map((f) => f.familyName)).toContain("Testfamily");
    expect(plan.guestCreates.map((g) => g.firstName)).toContain("Ada");
    expect(plan.eventUpdates).toHaveLength(0);
    expect(plan.guestUpdates).toHaveLength(0);
    expect(plan.familyRemoves).toHaveLength(0);
    expect(plan.guestRemoves).toHaveLength(0);

    // The other tenant's ids must never surface in any mutating slice.
    const touchedIds = [
      ...plan.familyRemoves.map((f) => f.id),
      ...plan.guestRemoves.map((g) => g.id),
      ...plan.guestUpdates.map((g) => g.id),
      ...plan.eventRemoves.map((e) => e.id),
      ...plan.eventUpdates.map((e) => e.id),
    ];
    expect(touchedIds).not.toContain(other.familyId);
    expect(touchedIds).not.toContain(other.guestId);
    expect(touchedIds).not.toContain(other.eventId);
  });

  it("scopes eventLinkRemoves to the wedding, ignoring another tenant's links (T-S2)", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);
    const other = seedOtherWedding(db);
    const layer = Layer.succeed(DbService, db);

    // Populate the bootstrap wedding from the full sheet first.
    const { ev, fam } = await parsedFromCsv();
    await Effect.runPromise(
      Effect.gen(function* () {
        const seedPlan = yield* diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID);
        yield* applyImport("imp-seed", seedPlan, BOOTSTRAP_WEDDING_ID);
      }).pipe(Effect.provide(layer)),
    );

    // Re-diff with Ada (Testfamily) dropped from every event → the bootstrap
    // wedding now yields real eventLinkRemoves, exercising the link-remove
    // branch with a second tenant's links present in guest_events.
    const shrunk = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Catholic Ceremony,Mehendi,Hindu Ceremony,Reception",
      "1,Testfamily,Ada,Testfamily,no,no,no,no",
      "2,Sampleton,Bo,Sampleton,no,no,yes,yes",
      "2,Sampleton,Cleo,Sampleton,no,no,yes,yes",
      "2,Sampleton,Dot,Sampleton,no,no,yes,no",
      "3,Exampleton,Nori,Exampleton,yes,no,yes,no",
      "4,Placeholder,Eli,Placeholder,no,no,yes,yes",
    ].join("\n");
    const ev2 = await Effect.runPromise(parseEventsCsv(FOUR_EVENTS_CSV));
    const fam2 = (await Effect.runPromise(parseGuestsCsv(shrunk, ev2))) as ParsedFamily[];
    const plan = await Effect.runPromise(
      diffAgainstDb(ev2, fam2, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    expect(plan.eventLinkRemoves.length).toBeGreaterThan(0);
    // None of the removed pairs reference the other tenant's guest or event.
    for (const link of plan.eventLinkRemoves) {
      expect(link.guestId).not.toBe(other.guestId);
      expect(link.eventId).not.toBe(other.eventId);
    }
  });
});

describe("applyImport: chunks a large diff into ≤50-statement batches", () => {
  it("splits a 120-statement write set into ceil(120/50)=3 ordered batches", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);

    // Seed one event so the new guests have something to link to — exercises a
    // parent (guest insert) → child (guest_events insert) dependency the chunker
    // must keep ordered even when a chunk boundary falls between them.
    const eventId = crypto.randomUUID();
    db.insert(events)
      .values({
        id: eventId,
        weddingId: BOOTSTRAP_WEDDING_ID,
        slug: "evt-chunk",
        name: "Chunk Event",
        description: "",
        startAt: "",
        endAt: "",
        timezone: "",
        address: null,
        dressCodeDescription: null,
        dressCodePalette: null,
        pinterestUrl: null,
        mapsUrl: null,
        sortOrder: 0,
      })
      .run();

    // bun:sqlite has no native `.batch()`, so the importer's chunking branch is
    // never reached on it. Install a counting `.batch` shim that executes its
    // statements sequentially (faithful to D1's in-order batch semantics) so we
    // can assert (a) the write set is split into ≤50-statement chunks and
    // (b) every row still lands. Running on bun:sqlite keeps this fast + free of
    // the Miniflare cold-start flake the real-D1 suite has.
    const chunkSizes: number[] = [];
    (db as unknown as { batch: (stmts: unknown[]) => Promise<unknown> }).batch = async (
      stmts: unknown[],
    ) => {
      chunkSizes.push(stmts.length);
      const out: unknown[] = [];
      for (const s of stmts) out.push(await (s as Promise<unknown>));
      return out;
    };

    // 40 families × (family + guest + link) = 120 statements.
    const N = 40;
    const familyCreates = Array.from({ length: N }, (_, i) => ({
      id: `bigfam_${i}`,
      publicId: `BIGFAM-${String(i).padStart(4, "0")}`,
      familyName: `Big Family ${i}`,
    }));
    const guestCreates = familyCreates.map((f, i) => ({
      id: `bigguest_${i}`,
      familyId: f.id,
      firstName: `First${i}`,
      lastName: `Last${i}`,
      sortOrder: 0,
    }));
    const eventLinkCreates = guestCreates.map((g) => ({ guestId: g.id, eventId }));

    const plan = {
      eventCreates: [],
      eventUpdates: [],
      eventRemoves: [],
      familyCreates,
      familyRemoves: [],
      guestCreates,
      guestUpdates: [],
      guestRemoves: [],
      eventLinkCreates,
      eventLinkRemoves: [],
      warnings: [],
    };

    const totalStatements = familyCreates.length + guestCreates.length + eventLinkCreates.length;
    expect(totalStatements).toBe(120);

    const layer = Layer.succeed(DbService, db);
    const summary = await Effect.runPromise(
      applyImport("imp_big", plan, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
    expect(summary).toMatchObject({ familiesCreated: N, guestsCreated: N });

    // ceil(120 / 50) = 3 chunks of 50, 50, 20 — no chunk exceeds the cap.
    expect(chunkSizes).toEqual([50, 50, 20]);
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(50);

    // Every row landed — ordering held across chunk boundaries (each guest's
    // guest_events link still committed after the guest insert, even split).
    expect(db.select().from(families).all()).toHaveLength(N);
    expect(db.select().from(guests).all()).toHaveLength(N);
    expect(db.select().from(guestEvents).all()).toHaveLength(N);
    expect(
      db
        .select()
        .from(guests)
        .where(eq(guests.id, `bigguest_${N - 1}`))
        .all(),
    ).toHaveLength(1);
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
        const plan = yield* diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID);
        yield* applyImport("imp-1", plan, BOOTSTRAP_WEDDING_ID);
      }).pipe(Effect.provide(sharedLayer)),
    );
    expect(sharedDb.select().from(events).all()).toHaveLength(4);
    expect(sharedDb.select().from(families).all()).toHaveLength(4);
    expect(sharedDb.select().from(guests).all()).toHaveLength(6);
    expect(sharedDb.select().from(guestEvents).all().length).toBeGreaterThan(0);
  });
});

describe("applyImport: optional End + Location → Address fallback", () => {
  // End and Location are optional in the events sheet: a blank End stores the
  // "" no-stated-end sentinel, and a Location venue name fills in for a blank
  // Address so the value reaches the invite's "Where" instead of being dropped.
  const MINIMAL_EVENTS_CSV = [
    "Event Name,Start,Timezone,Location,Address",
    "Ceremony,2026-10-31T10:00:00+11:00,Australia/Sydney,Example Parish,",
    "Reception,2026-10-31T18:00:00+11:00,Australia/Sydney,Sample House,126 Example Road",
    "Afterparty,2026-11-01T00:00:00+11:00,Australia/Sydney,,",
  ].join("\n");

  it("stores endAt '' and falls back Location → address only when Address is blank", async () => {
    const ev = await Effect.runPromise(parseEventsCsv(MINIMAL_EVENTS_CSV));
    const sharedDb = createDb(":memory:");
    seedBootstrapWedding(sharedDb);
    const sharedLayer = Layer.succeed(DbService, sharedDb);
    await Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* diffAgainstDb(ev, [], BOOTSTRAP_WEDDING_ID);
        yield* applyImport("imp-minimal", plan, BOOTSTRAP_WEDDING_ID);
      }).pipe(Effect.provide(sharedLayer)),
    );
    const rows = sharedDb.select().from(events).all();
    const ceremony = rows.find((r) => r.name === "Ceremony")!;
    const reception = rows.find((r) => r.name === "Reception")!;
    const afterparty = rows.find((r) => r.name === "Afterparty")!;
    expect(ceremony.endAt).toBe("");
    expect(ceremony.address).toBe("Example Parish");
    expect(reception.address).toBe("126 Example Road");
    // Neither Address nor Location ⇒ null (invite hides the "Where" affordances).
    expect(afterparty.address).toBeNull();
  });

  it("update path applies the same fallback to an existing event", async () => {
    const sharedDb = createDb(":memory:");
    seedBootstrapWedding(sharedDb);
    const sharedLayer = Layer.succeed(DbService, sharedDb);
    await Effect.runPromise(
      Effect.gen(function* () {
        const { ev, fam } = yield* Effect.promise(() => parsedFromCsv());
        const seedPlan = yield* diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID);
        yield* applyImport("imp-seed", seedPlan, BOOTSTRAP_WEDDING_ID);
        // Re-import the Catholic Ceremony with a blank Address but a Location.
        const updated = yield* parseEventsCsv(
          [
            "Event Name,Start,Timezone,Location,Address",
            "Catholic Ceremony,2026-10-31T10:00:00+11:00,Australia/Sydney,Example Parish,",
          ].join("\n"),
        );
        const plan2 = yield* diffAgainstDb(updated, [], BOOTSTRAP_WEDDING_ID);
        yield* applyImport("imp-update", plan2, BOOTSTRAP_WEDDING_ID);
      }).pipe(Effect.provide(sharedLayer)),
    );
    const row = sharedDb
      .select()
      .from(events)
      .all()
      .find((r) => r.name === "Catholic Ceremony")!;
    expect(row.address).toBe("Example Parish");
    expect(row.endAt).toBe("");
  });
});

// ── diffAgainstDb capacity warning (non-blocking) ───────────────────────────

describe("diffAgainstDb — non-blocking capacity warning", () => {
  it("adds a warning when the resulting headcount exceeds the cap, but does NOT fail", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);
    const layer = Layer.succeed(DbService, db);

    // Seed 95 real guests directly so the next import of 10 guests
    // produces a resulting count of 105, which exceeds the default cap of 100.
    // Use source='manual' so the CSV import (removeManual=false by default)
    // leaves these guests in place — they count toward existingGuests.length
    // without being added to guestRemoves.
    const now = new Date();
    const seedFamilyId = crypto.randomUUID();
    db.insert(families)
      .values({
        id: seedFamilyId,
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "WARN-SEED-FAM",
        familyName: "SeedFamily",
        kind: "guest",
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    for (let i = 0; i < 95; i++) {
      db.insert(guests)
        .values({
          id: crypto.randomUUID(),
          familyId: seedFamilyId,
          firstName: `SeedGuest${i}`,
          lastName: "Seed",
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    // diffAgainstDb a plan that adds 10 new guests → resulting = 95 + 10 = 105 > 100.
    const parsedFamily: ParsedFamily = {
      familyName: "WarnTestFamily",
      guests: Array.from({ length: 10 }, (_, i) => ({
        firstName: `WarnGuest${i}`,
        lastName: "Warn",
        nickname: null,
        eventNames: [],
      })),
    };

    // Must succeed (non-blocking) — no exception or failure.
    const plan = await Effect.runPromise(
      diffAgainstDb([], [parsedFamily], BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    // The warning must be present and contain the stable "capped at 100" phrase.
    expect(plan.warnings.length).toBeGreaterThan(0);
    const capacityWarning = plan.warnings.find((w) => /capped at 100/i.test(w));
    expect(capacityWarning).toBeDefined();

    // The plan still contains the creates (diff is not blocked).
    expect(plan.guestCreates).toHaveLength(10);
  });
});

// ── Capacity enforcement ──────────────────────────────────────────────────────

/**
 * Build a minimal ParsedFamily with N guests (no events), for capacity tests.
 */
function planCreatingNGuests(
  db: ReturnType<typeof createDb>,
  n: number,
  weddingId = BOOTSTRAP_WEDDING_ID,
): Effect.Effect<import("../schemas/import").ImportPlan, never, DbService> {
  return Effect.gen(function* () {
    // One family, N guests, no events.
    const parsedFamily: ParsedFamily = {
      familyName: "CapTestFamily",
      guests: Array.from({ length: n }, (_, i) => ({
        firstName: `Guest${i}`,
        lastName: "Cap",
        nickname: null,
        eventNames: [],
      })),
    };
    return yield* diffAgainstDb([], [parsedFamily], weddingId);
  }).pipe(Effect.provideService(DbService, db));
}

describe("applyImport — capacity enforcement", () => {
  it("applyImport fails with CapacityExceeded when net-new guests breach the derived cap, writing nothing", async () => {
    const db = createDb();
    seedBootstrapWedding(db);
    // cap 100 (no capacity entitlement), plan creates 101 guests
    const plan = await Effect.runPromise(planCreatingNGuests(db, 101));
    const exit = await Effect.runPromiseExit(
      applyImport("imp_cap_1", plan, BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, db),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    // Atomic: no guests were written.
    const n = (db.$client.query("SELECT COUNT(*) AS n FROM guests").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it("applyImport succeeds at exactly the cap (100 guests)", async () => {
    const db = createDb();
    seedBootstrapWedding(db);
    const plan = await Effect.runPromise(planCreatingNGuests(db, 100));
    const exit = await Effect.runPromiseExit(
      applyImport("imp_cap_2", plan, BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, db),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const n = (db.$client.query("SELECT COUNT(*) AS n FROM guests").get() as { n: number }).n;
    expect(n).toBe(100);
  });

  it("host-preview family guests do NOT count toward the cap", async () => {
    // Seed 99 real guests directly (bypassing diff so they aren't removed by
    // subsequent diffAgainstDb calls). Then create a host family with 1 guest.
    // The entitlementService must exclude host guests from the count:
    //   real=99, host=1 → adding 1 real guest = 100 (≤100) → OK
    //   then adding 1 more real guest = 101 (>100) → CapacityExceeded
    const db = createDb();
    seedBootstrapWedding(db);
    const now = new Date();
    const layer = Layer.succeed(DbService, db);

    // Insert 99 real guests directly.
    const realFamilyId = crypto.randomUUID();
    db.insert(families)
      .values({
        id: realFamilyId,
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "REAL-FAM-CAP",
        familyName: "RealFamily",
        kind: "guest",
        source: "import",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    for (let i = 0; i < 99; i++) {
      db.insert(guests)
        .values({
          id: crypto.randomUUID(),
          familyId: realFamilyId,
          firstName: `RealGuest${i}`,
          lastName: "Real",
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    // Provision a host family (kind='host') with its synthetic guest.
    await Effect.runPromise(
      hostCodeService
        .ensureForWedding(BOOTSTRAP_WEDDING_ID)
        .pipe(Effect.provideService(DbService, db)),
    );

    // Adding 1 real guest → 99+1=100 ≤ 100 → should succeed.
    const addOnePlan: import("../schemas/import").ImportPlan = {
      eventCreates: [],
      eventUpdates: [],
      eventRemoves: [],
      familyCreates: [{ id: crypto.randomUUID(), publicId: "ONE-MORE-CAP", familyName: "OneMore" }],
      familyRemoves: [],
      guestCreates: [],
      guestUpdates: [],
      guestRemoves: [],
      eventLinkCreates: [],
      eventLinkRemoves: [],
      warnings: [],
    };
    const oneMoreFamilyId = addOnePlan.familyCreates[0]!.id;
    addOnePlan.guestCreates.push({
      id: crypto.randomUUID(),
      familyId: oneMoreFamilyId,
      firstName: "Last",
      lastName: "Guest",
      nickname: null,
      sortOrder: 0,
    });
    const exit1 = await Effect.runPromiseExit(
      applyImport("imp_cap_host_2", addOnePlan, BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, db),
      ),
    );
    expect(Exit.isSuccess(exit1)).toBe(true);

    // Now adding 1 more real guest → 100+1=101 > 100 → should fail.
    const overflowPlan: import("../schemas/import").ImportPlan = {
      eventCreates: [],
      eventUpdates: [],
      eventRemoves: [],
      familyCreates: [{ id: crypto.randomUUID(), publicId: "TOO-MANY-CAP", familyName: "TooMany" }],
      familyRemoves: [],
      guestCreates: [],
      guestUpdates: [],
      guestRemoves: [],
      eventLinkCreates: [],
      eventLinkRemoves: [],
      warnings: [],
    };
    overflowPlan.guestCreates.push({
      id: crypto.randomUUID(),
      familyId: overflowPlan.familyCreates[0]!.id,
      firstName: "Overflow",
      lastName: "Guest",
      nickname: null,
      sortOrder: 0,
    });
    const exit2 = await Effect.runPromiseExit(
      applyImport("imp_cap_host_3", overflowPlan, BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, db),
      ),
    );
    expect(Exit.isFailure(exit2)).toBe(true);

    // The overflow guest must NOT have been persisted (atomic).
    const n = (
      db.$client
        .query(
          `SELECT COUNT(*) AS n FROM guests g
         JOIN families f ON g.family_id = f.id
         WHERE f.kind != 'host' AND f.wedding_id = '${BOOTSTRAP_WEDDING_ID}'`,
        )
        .get() as { n: number }
    ).n;
    // 99 real + 1 "Last" from the succeeded import = 100.
    expect(n).toBe(100);
  });

  it("upgraded wedding (capacity_500) allows more guests", async () => {
    const db = createDb();
    seedBootstrapWedding(db);
    const layer = Layer.succeed(DbService, db);

    await Effect.runPromise(
      Effect.gen(function* () {
        // Grant capacity_500
        yield* entitlementService.grant(BOOTSTRAP_WEDDING_ID, "capacity_500", {
          source: "comp",
          grantedBy: "usr_admin",
        });
        // 101 guests under cap of 500 → succeeds.
        const plan = yield* planCreatingNGuests(db, 101, BOOTSTRAP_WEDDING_ID);
        const exit = yield* Effect.exit(applyImport("imp_cap_up", plan, BOOTSTRAP_WEDDING_ID));
        expect(Exit.isSuccess(exit)).toBe(true);
      }).pipe(Effect.provide(layer)),
    );
  });

  // SWAP-AT-CAP: remove K guests and add K guests when already at the cap.
  // Net delta = 0, so the capacity gate must NOT fire even though guestCreates.length > 0.
  it("swap-at-cap: remove K and add K at exactly cap → succeeds (net delta = 0)", async () => {
    const db = createDb();
    seedBootstrapWedding(db);
    const layer = Layer.succeed(DbService, db);
    const now = new Date();

    // Seed exactly 100 real guests (= default cap) directly as import-sourced.
    const seedFamilyId = crypto.randomUUID();
    db.insert(families)
      .values({
        id: seedFamilyId,
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "SWAP-SEED-FAM",
        familyName: "SwapSeedFamily",
        kind: "guest",
        source: "import",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const seedGuestIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = crypto.randomUUID();
      seedGuestIds.push(id);
      db.insert(guests)
        .values({
          id,
          familyId: seedFamilyId,
          firstName: `SwapGuest${i}`,
          lastName: "Seed",
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const K = 5;
    // Build a plan that removes K existing guests and adds K new guests (net = 0).
    const swapPlan: import("../schemas/import").ImportPlan = {
      eventCreates: [],
      eventUpdates: [],
      eventRemoves: [],
      familyCreates: [],
      familyRemoves: [],
      guestCreates: Array.from({ length: K }, (_, i) => ({
        id: crypto.randomUUID(),
        familyId: seedFamilyId,
        firstName: `NewSwapGuest${i}`,
        lastName: "New",
        nickname: null,
        sortOrder: 100 + i,
      })),
      guestUpdates: [],
      guestRemoves: seedGuestIds.slice(0, K).map((id) => ({ id, firstName: "SwapGuest" })),
      eventLinkCreates: [],
      eventLinkRemoves: [],
      warnings: [],
    };

    // Net delta = 0 → must succeed even at cap.
    const exit = await Effect.runPromiseExit(
      applyImport("imp_swap_at_cap", swapPlan, BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, db),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);

    // Still at cap: 100 - K + K = 100.
    const n = (db.$client.query("SELECT COUNT(*) AS n FROM guests").get() as { n: number }).n;
    expect(n).toBe(100);
  });

  it("swap-at-cap: remove K and add K+1 at exactly cap → CapacityExceeded", async () => {
    const db = createDb();
    seedBootstrapWedding(db);
    const now = new Date();

    // Seed exactly 100 real guests.
    const seedFamilyId = crypto.randomUUID();
    db.insert(families)
      .values({
        id: seedFamilyId,
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "SWAP-OVER-FAM",
        familyName: "SwapOverFamily",
        kind: "guest",
        source: "import",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const seedGuestIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = crypto.randomUUID();
      seedGuestIds.push(id);
      db.insert(guests)
        .values({
          id,
          familyId: seedFamilyId,
          firstName: `OverGuest${i}`,
          lastName: "Seed",
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const K = 5;
    // Remove K, add K+1 → net delta = +1, which breaches the cap.
    const overPlan: import("../schemas/import").ImportPlan = {
      eventCreates: [],
      eventUpdates: [],
      eventRemoves: [],
      familyCreates: [],
      familyRemoves: [],
      guestCreates: Array.from({ length: K + 1 }, (_, i) => ({
        id: crypto.randomUUID(),
        familyId: seedFamilyId,
        firstName: `NewOverGuest${i}`,
        lastName: "New",
        nickname: null,
        sortOrder: 100 + i,
      })),
      guestUpdates: [],
      guestRemoves: seedGuestIds.slice(0, K).map((id) => ({ id, firstName: "OverGuest" })),
      eventLinkCreates: [],
      eventLinkRemoves: [],
      warnings: [],
    };

    const exit = await Effect.runPromiseExit(
      applyImport("imp_swap_over_cap", overPlan, BOOTSTRAP_WEDDING_ID).pipe(
        Effect.provideService(DbService, db),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);

    // Atomic: still 100 guests (no partial write).
    const n = (db.$client.query("SELECT COUNT(*) AS n FROM guests").get() as { n: number }).n;
    expect(n).toBe(100);
  });
});
