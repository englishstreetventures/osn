import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, families, guests, guestEvents } from "@cire/db";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { DbService } from "../db";
import type { Db } from "../db";
import { createDb, seedBootstrapWedding } from "../db/setup";
import type { ParsedEvent, ParsedFamily } from "../schemas/import";
import { applyImport, diffAgainstDb } from "./import";

/**
 * ROW IDENTITY in the reconcile diff — which desired row means which existing
 * row, and (the part these tests exist for) which existing rows are therefore
 * DELETIONS.
 *
 * The guest editor posts its whole draft as a DesiredState, so a deletion is
 * expressed by absence: the dropped row simply isn't there. Anything that makes
 * an existing guest unreachable to the removal scan, or lets a surviving desired
 * row adopt the dropped one, silently swallows the deletion — the organiser
 * deletes a guest, the plan says "0 removed", and the guest is back on reload.
 * That is the bug class pinned here.
 */

function freshDb(): { db: Db; layer: Layer.Layer<DbService> } {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  return { db, layer: Layer.succeed(DbService, db) };
}

const CEREMONY: ParsedEvent = {
  name: "Ceremony",
  startAt: "2026-11-14T15:00:00+11:00",
  endAt: "",
  timezone: "Australia/Sydney",
  location: null,
  address: null,
  dressCodeDescription: null,
  dressCodePalette: [],
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
};

function guest(firstName: string, lastName: string, id?: string) {
  return {
    ...(id ? { id } : {}),
    firstName,
    lastName,
    nickname: null,
    eventNames: ["Ceremony"],
  };
}

/** Seed one household straight from a desired state, then read back its rows. */
async function seedHousehold(
  layer: Layer.Layer<DbService>,
  db: Db,
  familyName: string,
  members: { firstName: string; lastName: string }[],
) {
  const desired: ParsedFamily[] = [
    { familyName, guests: members.map((m) => guest(m.firstName, m.lastName)) },
  ];
  await Effect.runPromise(
    Effect.gen(function* () {
      const plan = yield* diffAgainstDb([CEREMONY], desired, BOOTSTRAP_WEDDING_ID);
      yield* applyImport("seed", plan, BOOTSTRAP_WEDDING_ID);
    }).pipe(Effect.provide(layer)),
  );
  const family = db.select().from(families).all()[0]!;
  const rows = db.select().from(guests).all();
  return { family, rows };
}

describe("diffAgainstDb — a guest whose first name collides with a sibling's", () => {
  /**
   * Two guests in one household CAN normalise to the same first name (a sheet
   * carrying "Sam" and "sam ", a household of two "Guest"s). The per-family
   * collection the removal scan reads used to be keyed by that normalised name,
   * so one of the two was shadowed out of it entirely: dropping that guest from
   * the desired state emitted NO removal at all, and the editor's delete was a
   * silent no-op.
   */
  it("emits a removal for the shadowed duplicate, not for its twin", async () => {
    const { db, layer } = freshDb();
    const { family, rows } = await seedHousehold(layer, db, "Sharma", [
      { firstName: "Sam", lastName: "Sharma" },
      { firstName: "sam ", lastName: "Lee" },
    ]);
    expect(rows).toHaveLength(2);
    const shadowed = rows.find((r) => r.lastName === "Sharma")!;
    const kept = rows.find((r) => r.lastName === "Lee")!;

    // The editor drops the FIRST Sam and keeps the second, ids and all.
    const desired: ParsedFamily[] = [
      {
        id: family.id,
        publicId: family.publicId,
        familyName: "Sharma",
        guests: [guest(kept.firstName, kept.lastName, kept.id)],
      },
    ];
    const plan = await Effect.runPromise(
      diffAgainstDb([{ ...CEREMONY }], desired, BOOTSTRAP_WEDDING_ID, {
        removeManual: true,
        matchByName: false,
      }).pipe(Effect.provide(layer)),
    );

    expect(plan.guestRemoves.map((g) => g.id)).toEqual([shadowed.id]);
  });

  it("re-importing a duplicate-name roster is a no-op, and each twin keeps its own links", async () => {
    const { db, layer } = freshDb();
    const { family } = await seedHousehold(layer, db, "Sharma", [
      { firstName: "Sam", lastName: "Sharma" },
      { firstName: "sam", lastName: "Lee" },
    ]);

    // Both were invited to the Ceremony, and both links must survive: the link
    // pass used to resolve BOTH parsed rows to one guest id, so one twin
    // collected two links and the other's was diffed away.
    expect(db.select().from(guestEvents).all()).toHaveLength(2);

    // The same sheet again — id-less, matched by name, exactly as a re-upload.
    const desired: ParsedFamily[] = [
      {
        familyName: family.familyName,
        guests: [guest("Sam", "Sharma"), guest("sam", "Lee")],
      },
    ];
    const plan = await Effect.runPromise(
      diffAgainstDb([{ ...CEREMONY }], desired, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    expect(plan.guestRemoves).toHaveLength(0);
    expect(plan.guestCreates).toHaveLength(0);
    expect(plan.eventLinkCreates).toHaveLength(0);
    expect(plan.eventLinkRemoves).toHaveLength(0);
  });
});

describe("diffAgainstDb — matchByName: false (the editor front door)", () => {
  /**
   * The editor's draft is built from server rows, so it carries an id for every
   * row that exists. An id-less row therefore means "just added" — and adopting
   * a same-named existing row instead cancelled the deletion of that row AND
   * handed the new guest the deleted one's RSVPs.
   */
  it("a new guest with a deleted guest's name is a remove + create, not an update", async () => {
    const { db, layer } = freshDb();
    const { family, rows } = await seedHousehold(layer, db, "Sharma", [
      { firstName: "Ada", lastName: "Sharma" },
      { firstName: "Bob", lastName: "Sharma" },
    ]);
    const ada = rows.find((r) => r.firstName === "Ada")!;
    const bob = rows.find((r) => r.firstName === "Bob")!;

    // Delete Bob; add a different Bob (no id — a brand-new row).
    const desired: ParsedFamily[] = [
      {
        id: family.id,
        publicId: family.publicId,
        familyName: "Sharma",
        guests: [guest("Ada", "Sharma", ada.id), guest("Bob", "Newman")],
      },
    ];
    const plan = await Effect.runPromise(
      diffAgainstDb([{ ...CEREMONY }], desired, BOOTSTRAP_WEDDING_ID, {
        removeManual: true,
        matchByName: false,
      }).pipe(Effect.provide(layer)),
    );

    expect(plan.guestRemoves.map((g) => g.id)).toEqual([bob.id]);
    expect(plan.guestCreates.map((g) => g.lastName)).toEqual(["Newman"]);
  });

  it("a new household with a deleted household's name is a remove + create", async () => {
    const { db, layer } = freshDb();
    const { family } = await seedHousehold(layer, db, "Sharma", [
      { firstName: "Ada", lastName: "Sharma" },
    ]);

    const desired: ParsedFamily[] = [{ familyName: "Sharma", guests: [guest("Zoe", "Sharma")] }];
    const plan = await Effect.runPromise(
      diffAgainstDb([{ ...CEREMONY }], desired, BOOTSTRAP_WEDDING_ID, {
        removeManual: true,
        matchByName: false,
      }).pipe(Effect.provide(layer)),
    );

    expect(plan.familyRemoves.map((f) => f.id)).toEqual([family.id]);
    expect(plan.familyCreates).toHaveLength(1);
  });

  it("a CSV upload still matches by name (the flag defaults off)", async () => {
    const { db, layer } = freshDb();
    const { family } = await seedHousehold(layer, db, "Sharma", [
      { firstName: "Ada", lastName: "Sharma" },
    ]);

    // Same household + guest by NAME only, no ids anywhere — the sheet shape.
    const desired: ParsedFamily[] = [
      { familyName: "Sharma", guests: [guest("Ada", "Sharma-Lee")] },
    ];
    const plan = await Effect.runPromise(
      diffAgainstDb([{ ...CEREMONY }], desired, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );

    expect(plan.familyCreates).toHaveLength(0);
    expect(plan.familyRemoves).toHaveLength(0);
    expect(plan.guestRemoves).toHaveLength(0);
    expect(plan.guestUpdates.map((g) => g.lastName)).toEqual(["Sharma-Lee"]);
    expect(db.select().from(families).all()[0]!.id).toBe(family.id);
  });
});

describe("diffAgainstDb — an existing row is claimed by at most one desired row", () => {
  /**
   * Two desired households that resolve to ONE existing row used to reconcile
   * against that row's guest list twice in a row, and the second pass removed
   * every guest the first pass had just matched.
   */
  it("a second household with the same name creates rather than re-claiming", async () => {
    const { db, layer } = freshDb();
    await seedHousehold(layer, db, "Smith", [
      { firstName: "Ada", lastName: "Smith" },
      { firstName: "Bob", lastName: "Smith" },
    ]);

    const desired: ParsedFamily[] = [
      { familyName: "Smith", guests: [guest("Ada", "Smith")] },
      { familyName: "Smith", guests: [guest("Bob", "Smith")] },
    ];
    const plan = await Effect.runPromise(
      diffAgainstDb([{ ...CEREMONY }], desired, BOOTSTRAP_WEDDING_ID, { removeManual: true }).pipe(
        Effect.provide(layer),
      ),
    );

    // The second "Smith" becomes its own household; Bob moves into it. What must
    // NOT happen is the pair of passes deleting each other's guests.
    expect(plan.familyCreates).toHaveLength(1);
    expect(plan.familyRemoves).toHaveLength(0);
    expect(plan.guestRemoves.map((g) => g.firstName)).toEqual(["Bob"]);
    expect(plan.guestCreates.map((g) => g.firstName)).toEqual(["Bob"]);
  });
});

describe("diffAgainstDb — events reconcile by the same identity rules", () => {
  /** Seed a wedding with two named events, and hand back their rows. */
  async function seedEvents(layer: Layer.Layer<DbService>, db: Db, names: string[]) {
    const desired: ParsedEvent[] = names.map((name, i) => ({ ...CEREMONY, name, sortOrder: i }));
    await Effect.runPromise(
      Effect.gen(function* () {
        const plan = yield* diffAgainstDb(desired, [], BOOTSTRAP_WEDDING_ID);
        yield* applyImport("seed-events", plan, BOOTSTRAP_WEDDING_ID);
      }).pipe(Effect.provide(layer)),
    );
    return db.select().from(events).all();
  }

  it("a new event reusing a deleted event's name is a remove + create", async () => {
    const { db, layer } = freshDb();
    const rows = await seedEvents(layer, db, ["Ceremony", "Reception"]);
    const ceremony = rows.find((e) => e.name === "Ceremony")!;
    const reception = rows.find((e) => e.name === "Reception")!;

    // Keep the Ceremony by id; drop the Reception and add a fresh, id-less one
    // under the same name — the guest-side bug, one entity up. Left as an update
    // it would silently keep the deleted event's guest links and RSVPs.
    const desired: ParsedEvent[] = [
      { ...CEREMONY, id: ceremony.id, name: "Ceremony", sortOrder: 0 },
      { ...CEREMONY, name: "Reception", sortOrder: 1 },
    ];
    const plan = await Effect.runPromise(
      diffAgainstDb(desired, [], BOOTSTRAP_WEDDING_ID, {
        removeManual: true,
        matchByName: false,
      }).pipe(Effect.provide(layer)),
    );

    expect(plan.eventRemoves.map((e) => e.id)).toEqual([reception.id]);
    expect(plan.eventCreates.map((e) => e.event.name)).toEqual(["Reception"]);
    expect(plan.eventUpdates.map((e) => e.id)).toEqual([ceremony.id]);
  });

  it("two desired events with one name claim the existing row once, and attendance follows the second", async () => {
    const { db, layer } = freshDb();
    await seedEvents(layer, db, ["Ceremony"]);

    const desired: ParsedEvent[] = [
      { ...CEREMONY, name: "Ceremony", sortOrder: 0 },
      { ...CEREMONY, name: "ceremony ", sortOrder: 1 },
    ];
    const desiredFamilies: ParsedFamily[] = [
      { familyName: "Sharma", guests: [guest("Ada", "Sharma")] },
    ];
    const plan = await Effect.runPromise(
      diffAgainstDb(desired, desiredFamilies, BOOTSTRAP_WEDDING_ID, { removeManual: true }).pipe(
        Effect.provide(layer),
      ),
    );

    // One update (the first claims the existing row), one create, no removes.
    expect(plan.eventUpdates).toHaveLength(1);
    expect(plan.eventCreates).toHaveLength(1);
    expect(plan.eventRemoves).toHaveLength(0);
    // `eventIdByNorm` is keyed by normalised name, so the LAST writer wins and a
    // guest invited to "Ceremony" binds to the second event. Asserted so the
    // overwrite is a reviewed decision rather than an accident: the editor blocks
    // duplicate event names client-side, and the sheet parser is the only way to
    // reach this shape at all.
    expect(plan.eventLinkCreates).toHaveLength(1);
    expect(plan.eventLinkCreates[0]!.eventId).toBe(plan.eventCreates[0]!.id);
  });
});

describe("diffAgainstDb — a stale id-authoritative draft is refused, not applied", () => {
  /**
   * `baseRevision` guards preview→apply. Nothing guarded LOAD→preview, and with
   * name fallback off that window is destructive: a draft row whose id has since
   * been deleted reconciles as remove+create, dropping the RSVPs attached to it
   * and re-minting (or resurrecting) a household's claim code.
   */
  it("fails when a desired guest names an id that no longer exists", async () => {
    const { db, layer } = freshDb();
    const { family, rows } = await seedHousehold(layer, db, "Sharma", [
      { firstName: "Ada", lastName: "Sharma" },
    ]);
    const ada = rows[0]!;

    const desired: ParsedFamily[] = [
      {
        id: family.id,
        publicId: family.publicId,
        familyName: "Sharma",
        guests: [guest("Ada", "Sharma", ada.id), guest("Ghost", "Sharma", crypto.randomUUID())],
      },
    ];
    const exit = await Effect.runPromiseExit(
      diffAgainstDb([{ ...CEREMONY }], desired, BOOTSTRAP_WEDDING_ID, {
        removeManual: true,
        matchByName: false,
      }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();
    expect(Option.isSome(failure)).toBe(true);
    expect(Option.getOrThrow(failure)._tag).toBe("StaleDesiredState");
  });

  it("fails when a desired household names an id that no longer exists", async () => {
    const { db, layer } = freshDb();
    await seedHousehold(layer, db, "Sharma", [{ firstName: "Ada", lastName: "Sharma" }]);

    const desired: ParsedFamily[] = [
      {
        id: crypto.randomUUID(),
        publicId: "GONE-CODE-0001",
        familyName: "Sharma",
        guests: [guest("Ada", "Sharma")],
      },
    ];
    const exit = await Effect.runPromiseExit(
      diffAgainstDb([{ ...CEREMONY }], desired, BOOTSTRAP_WEDDING_ID, {
        removeManual: true,
        matchByName: false,
      }).pipe(Effect.provide(layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("a CSV's dangling id still falls through to name matching", async () => {
    const { db, layer } = freshDb();
    const { family } = await seedHousehold(layer, db, "Sharma", [
      { firstName: "Ada", lastName: "Sharma" },
    ]);

    // Same shape, default options: the sheet path treats a dangling id as "this
    // sheet's ids are stale, match by name" — which is the documented behaviour
    // and must NOT become a refusal.
    const desired: ParsedFamily[] = [
      {
        id: crypto.randomUUID(),
        familyName: "Sharma",
        guests: [guest("Ada", "Sharma", crypto.randomUUID())],
      },
    ];
    const plan = await Effect.runPromise(
      diffAgainstDb([{ ...CEREMONY }], desired, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
    expect(plan.familyCreates).toHaveLength(0);
    expect(plan.familyRemoves).toHaveLength(0);
    expect(plan.guestRemoves).toHaveLength(0);
    expect(db.select().from(families).all()[0]!.id).toBe(family.id);
  });
});

describe("diffAgainstDb — a carried claim code that is already taken", () => {
  /**
   * `families.public_id` is globally unique, and a create may carry its own code
   * (the full-fidelity `Family Code` column). An already-taken code used to reach
   * the INSERT and fail mid-apply — the worst place for it, since applyImport
   * commits in chunks and stamps the before-image in the LAST batch, leaving a
   * half-written wedding with nothing to revert to.
   */
  it("mints a fresh code and warns, instead of colliding at apply time", async () => {
    const { db, layer } = freshDb();
    const { family } = await seedHousehold(layer, db, "Sharma", [
      { firstName: "Ada", lastName: "Sharma" },
    ]);

    // A second household asking for the FIRST one's live code.
    const desired: ParsedFamily[] = [
      {
        id: family.id,
        publicId: family.publicId,
        familyName: "Sharma",
        guests: [guest("Ada", "Sharma")],
      },
      { publicId: family.publicId, familyName: "Lee", guests: [guest("Cy", "Lee")] },
    ];
    const plan = await Effect.runPromise(
      diffAgainstDb([{ ...CEREMONY }], desired, BOOTSTRAP_WEDDING_ID, { removeManual: true }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(plan.familyCreates).toHaveLength(1);
    expect(plan.familyCreates[0]!.publicId).not.toBe(family.publicId);
    expect(plan.warnings.some((w) => w.includes("already in use"))).toBe(true);

    // And the plan actually commits — the collision is gone, not deferred.
    await Effect.runPromise(
      applyImport("collide", plan, BOOTSTRAP_WEDDING_ID).pipe(Effect.provide(layer)),
    );
    expect(db.select().from(families).all()).toHaveLength(2);
  });

  it("a code freed by this same plan's removal is reusable", async () => {
    const { db, layer } = freshDb();
    const { family } = await seedHousehold(layer, db, "Sharma", [
      { firstName: "Ada", lastName: "Sharma" },
    ]);

    // The old household is dropped (it is absent) and a new one claims its code —
    // an export → rename → re-import round trip, which must keep the invite live.
    const desired: ParsedFamily[] = [
      { publicId: family.publicId, familyName: "Sharma-Lee", guests: [guest("Ada", "Sharma")] },
    ];
    const plan = await Effect.runPromise(
      diffAgainstDb([{ ...CEREMONY }], desired, BOOTSTRAP_WEDDING_ID, { removeManual: true }).pipe(
        Effect.provide(layer),
      ),
    );
    expect(plan.familyRemoves.map((f) => f.id)).toEqual([family.id]);
    expect(plan.familyCreates[0]!.publicId).toBe(family.publicId);
    expect(plan.warnings.some((w) => w.includes("already in use"))).toBe(false);
  });
});

describe("diffAgainstDb — pass ordering and the editor fixpoint", () => {
  /**
   * Ids resolve across the WHOLE household before any name match, so a name match
   * can never consume a row a later parsed guest owns by id. Fold the two passes
   * back into one loop and every other test stays green while the id-owning guest
   * is orphaned into a remove+create — losing its RSVPs and links.
   */
  it("an id-less row cannot steal the row a later id-carrying row owns", async () => {
    const { db, layer } = freshDb();
    const { family, rows } = await seedHousehold(layer, db, "Sharma", [
      { firstName: "Sam", lastName: "Sharma" },
      { firstName: "Sam", lastName: "Lee" },
    ]);
    const sharma = rows.find((r) => r.lastName === "Sharma")!;
    const lee = rows.find((r) => r.lastName === "Lee")!;

    // A mixed-fidelity sheet: one row typed by hand (no id), one round-tripped
    // (id), both normalising to "sam". Default options — this is the CSV path.
    const desired: ParsedFamily[] = [
      {
        id: family.id,
        familyName: "Sharma",
        guests: [guest("Sam", "Typed"), guest("Sam", "Lee", lee.id)],
      },
    ];
    const plan = await Effect.runPromise(
      diffAgainstDb([{ ...CEREMONY }], desired, BOOTSTRAP_WEDDING_ID, { removeManual: true }).pipe(
        Effect.provide(layer),
      ),
    );

    // Lee is matched by id — never removed, never re-created. (It emits no
    // UPDATE either: every field of that row is unchanged, which is the point.)
    expect(plan.guestRemoves).toHaveLength(0);
    expect(plan.guestCreates).toHaveLength(0);
    expect(plan.guestUpdates.map((g) => g.id)).not.toContain(lee.id);
    // …and the id-less row consumed the OTHER Sam, rather than the one Lee owns.
    expect(plan.guestUpdates.map((g) => ({ id: g.id, lastName: g.lastName }))).toEqual([
      { id: sharma.id, lastName: "Typed" },
    ]);
  });

  /**
   * A no-op save is the commonest editor action and the cheapest detector for
   * this whole bug class: any matching regression shows up as a spurious
   * create/remove pair on a draft nobody edited.
   */
  it("a full-fidelity round trip with no edits is a fixpoint under matchByName: false", async () => {
    const { db, layer } = freshDb();
    const { family } = await seedHousehold(layer, db, "Sharma", [
      { firstName: "Sam", lastName: "Sharma" },
      { firstName: "sam ", lastName: "Lee" },
      { firstName: "Ada", lastName: "Sharma" },
    ]);
    // Plus a household holding no guests — the other shape the editor now carries.
    db.insert(families)
      .values({
        id: "fam_codeonly",
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "CODEONLY-0001",
        familyName: "Code Only",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const eventRow = db.select().from(events).all()[0]!;
    const guestRows = db.select().from(guests).all();
    const desired: ParsedFamily[] = [
      {
        id: family.id,
        publicId: family.publicId,
        familyName: family.familyName,
        guests: guestRows.map((g) => ({
          id: g.id,
          firstName: g.firstName,
          lastName: g.lastName,
          nickname: g.nickname,
          eventNames: ["Ceremony"],
        })),
      },
      { id: "fam_codeonly", publicId: "CODEONLY-0001", familyName: "Code Only", guests: [] },
    ];
    const plan = await Effect.runPromise(
      diffAgainstDb([{ ...CEREMONY, id: eventRow.id }], desired, BOOTSTRAP_WEDDING_ID, {
        removeManual: true,
        matchByName: false,
      }).pipe(Effect.provide(layer)),
    );

    expect(plan.eventCreates).toHaveLength(0);
    expect(plan.eventUpdates).toHaveLength(1); // id-matched, identical values
    expect(plan.eventRemoves).toHaveLength(0);
    expect(plan.familyCreates).toHaveLength(0);
    expect(plan.familyRemoves).toHaveLength(0);
    expect(plan.guestCreates).toHaveLength(0);
    expect(plan.guestUpdates).toHaveLength(0);
    expect(plan.guestRemoves).toHaveLength(0);
    expect(plan.eventLinkCreates).toHaveLength(0);
    expect(plan.eventLinkRemoves).toHaveLength(0);
  });
});
