import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families, guests, rsvps, weddingEntitlements } from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import type { ParsedEvent, ParsedFamily } from "../../src/schemas/import";
import { BASE_GUEST_CAP } from "../../src/services/entitlements";
import type { DiffOptions } from "../../src/services/import";
import { applyImport, diffAgainstDb } from "../../src/services/import";
import { parseEventsCsv, parseGuestsCsv } from "../../src/services/spreadsheet";
import { stateExportService } from "../../src/services/state-export";
import { recordStatements } from "../test-helpers";
import { eventIdsOf, guestNamed, seedPlusOne } from "../test-helpers/plus-one";

// A plus-one is the household's, not the organiser's: the change pipeline never
// matches, edits or removes one on its own account, removes one with their
// inviter, and keeps their invitations equal to the inviter's.

/** The editor's front door: ids authoritative, the draft the whole truth. */
const EDITOR: DiffOptions = { removeManual: true, matchByName: false };

function setUp() {
  const db = createDb(":memory:");
  seedDb(db);
  const bo = guestNamed(db, "Bo");
  const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
  const run = <A, E>(eff: Effect.Effect<A, E, DbService>) =>
    Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));
  return { db, bo, samId, run };
}

/** The wedding as a full-fidelity round trip parses it: every row id-bearing,
 *  the plus-one absent (the export leaves them out). */
function draftOf(db: TestDb) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const eventsCsv = yield* stateExportService.eventsCsv(BOOTSTRAP_WEDDING_ID, "full");
      const guestsCsv = yield* stateExportService.guestsCsv(BOOTSTRAP_WEDDING_ID, "full");
      const ev = yield* parseEventsCsv(eventsCsv);
      const fam = yield* parseGuestsCsv(guestsCsv, ev);
      return { ev: ev as ParsedEvent[], fam: fam as ParsedFamily[] };
    }).pipe(Effect.provideService(DbService, db)),
  );
}

const nameOfEvent = (ev: readonly ParsedEvent[], id: string) => ev.find((e) => e.id === id)!.name;

/** A household with its guest list swapped for `guests`. */
const withGuests = (family: ParsedFamily, members: ParsedFamily["guests"]): ParsedFamily =>
  Object.assign({}, family, { guests: members });

describe("diffAgainstDb — plus-ones", () => {
  it("leaves a plus-one alone when an editor draft omits them", async () => {
    const { db, samId, run } = setUp();
    const { ev, fam } = await draftOf(db);
    const plan = await run(diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID, EDITOR));
    expect(plan.guestRemoves.map((g) => g.id)).not.toContain(samId);
    expect(plan.guestUpdates).toHaveLength(0);
    expect(plan.eventLinkRemoves).toHaveLength(0);
    expect(plan.warnings).toHaveLength(0);
  });

  it("ignores a plus-one row an editor draft carries, instead of refusing the draft as stale", async () => {
    const { db, bo, samId, run } = setUp();
    const { ev, fam } = await draftOf(db);
    // Put the plus-one in their household, AHEAD of the other members and
    // renamed, with no invitations: every one of those is ignored.
    const withPlusOne = fam.map((f) =>
      f.id === bo.familyId
        ? withGuests(f, [
            { id: samId, firstName: "Renamed", lastName: "", nickname: null, eventNames: [] },
            ...f.guests,
          ])
        : f,
    );
    const plan = await run(diffAgainstDb(ev, withPlusOne, BOOTSTRAP_WEDDING_ID, EDITOR));
    expect(plan.guestCreates).toHaveLength(0);
    // No member's sort order moved because a plus-one row sat in front of them.
    expect(plan.guestUpdates).toHaveLength(0);
    expect(plan.guestRemoves).toHaveLength(0);
    expect(plan.eventLinkRemoves).toHaveLength(0);
  });

  it("ignores a plus-one on a spreadsheet upload that leaves them out", async () => {
    const { db, samId, run } = setUp();
    const { ev, fam } = await draftOf(db);
    for (const options of [{}, { removeManual: true }] satisfies DiffOptions[]) {
      const plan = await run(diffAgainstDb(ev, fam, BOOTSTRAP_WEDDING_ID, options));
      expect(plan.guestRemoves.map((g) => g.id)).not.toContain(samId);
      expect(plan.eventLinkRemoves.map((l) => l.guestId)).not.toContain(samId);
    }
  });

  it("removes the plus-one with their inviter, and says so", async () => {
    const { db, bo, samId, run } = setUp();
    db.insert(rsvps)
      .values({
        id: "r_sam",
        guestId: samId,
        eventId: eventsData.hindu.id,
        status: "attending",
        consentSource: "inviter_attested",
        createdAt: new Date(),
      })
      .run();
    const { ev, fam } = await draftOf(db);
    const withoutBo = fam.map((f) =>
      withGuests(
        f,
        f.guests.filter((g) => g.id !== bo.id),
      ),
    );

    const plan = await run(diffAgainstDb(ev, withoutBo, BOOTSTRAP_WEDDING_ID, EDITOR));
    expect(plan.guestRemoves.map((g) => g.id).toSorted()).toEqual([bo.id, samId].toSorted());
    expect(plan.warnings).toContain("Removing guest Bo also removes their plus-one Sam.");
    expect(
      plan.warnings.some((w) => w.startsWith("Removing guest Sam would lose their RSVP")),
    ).toBe(true);

    const summary = await run(applyImport("chg_bo", plan, BOOTSTRAP_WEDDING_ID));
    expect(summary.guestsRemoved).toBe(2);
    expect(db.select().from(guests).where(eq(guests.id, samId)).all()).toEqual([]);
  });

  it("removes a household's plus-ones once each when the household goes", async () => {
    const { db, bo, samId, run } = setUp();
    const { ev, fam } = await draftOf(db);
    const withoutHousehold = fam.filter((f) => f.id !== bo.familyId);
    const plan = await run(diffAgainstDb(ev, withoutHousehold, BOOTSTRAP_WEDDING_ID, EDITOR));
    expect(plan.guestRemoves.filter((g) => g.id === samId)).toHaveLength(1);
  });

  it("gives the plus-one the inviter's new invitations and takes away the dropped ones", async () => {
    const { db, bo, samId, run } = setUp();
    const { ev, fam } = await draftOf(db);
    // Bo: hindu + reception → reception + mehendi.
    const reception = nameOfEvent(ev, eventsData.reception.id);
    const mehendi = nameOfEvent(ev, eventsData.mehendi.id);
    const moved = fam.map((f) =>
      withGuests(
        f,
        f.guests.map((g) =>
          g.id === bo.id ? Object.assign({}, g, { eventNames: [reception, mehendi] }) : g,
        ),
      ),
    );

    const plan = await run(diffAgainstDb(ev, moved, BOOTSTRAP_WEDDING_ID, EDITOR));
    expect(plan.eventLinkCreates).toContainEqual({
      guestId: samId,
      eventId: eventsData.mehendi.id,
    });
    expect(plan.eventLinkRemoves).toContainEqual({ guestId: samId, eventId: eventsData.hindu.id });

    await run(applyImport("chg_move", plan, BOOTSTRAP_WEDDING_ID));
    expect(eventIdsOf(db, samId)).toEqual(eventIdsOf(db, bo.id));
  });

  it("counts plus-ones toward the guest cap in the preview", async () => {
    const { db, run } = setUp();
    // Fill the organiser's guests up to the base cap, less the one place the
    // plus-one already holds.
    const now = new Date();
    db.insert(families)
      .values({
        id: "fam_fill",
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "FILL-0001",
        familyName: "Filler",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const total = () =>
      db
        .select({ id: guests.id })
        .from(guests)
        .innerJoin(families, eq(guests.familyId, families.id))
        .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
        .all().length;
    for (let i = total(); i < BASE_GUEST_CAP; i++) {
      db.insert(guests)
        .values({
          id: `g_fill_${i}`,
          familyId: "fam_fill",
          firstName: `Filler${i}`,
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    db.delete(weddingEntitlements)
      .where(eq(weddingEntitlements.weddingId, BOOTSTRAP_WEDDING_ID))
      .run();

    const { ev, fam } = await draftOf(db);
    const oneMore = fam.map((f) =>
      f.id === "fam_fill"
        ? withGuests(f, [
            ...f.guests,
            { firstName: "Extra", lastName: "", nickname: null, eventNames: [] },
          ])
        : f,
    );
    const plan = await run(diffAgainstDb(ev, oneMore, BOOTSTRAP_WEDDING_ID, EDITOR));
    expect(plan.warnings.some((w) => w.includes(`capped at ${BASE_GUEST_CAP}`))).toBe(true);
  });
});

describe("diffAgainstDb — plus-ones on the spreadsheet door", () => {
  it("keeps a manual inviter left off an upload, and their plus-one's invitations still match theirs", async () => {
    const { db, bo, samId, run } = setUp();
    db.update(guests).set({ source: "manual" }).where(eq(guests.id, bo.id)).run();
    const { ev, fam } = await draftOf(db);
    const withoutBo = fam.map((f) =>
      withGuests(
        f,
        f.guests.filter((g) => g.id !== bo.id),
      ),
    );

    // The default spreadsheet options: manual rows are kept, names match.
    const plan = await run(diffAgainstDb(ev, withoutBo, BOOTSTRAP_WEDDING_ID));
    expect(plan.guestRemoves.map((g) => g.id)).not.toContain(bo.id);
    expect(plan.guestRemoves.map((g) => g.id)).not.toContain(samId);

    await run(applyImport("chg_manual", plan, BOOTSTRAP_WEDDING_ID));
    expect(db.select().from(guests).where(eq(guests.id, samId)).all()).toHaveLength(1);
    expect(eventIdsOf(db, samId)).toEqual(eventIdsOf(db, bo.id));
  });

  it("treats a sheet row with the plus-one's name as a new organiser guest, never as the plus-one", async () => {
    const { db, bo, samId, run } = setUp();
    const { ev, fam } = await draftOf(db);
    // A sheet with no id columns, as an organiser's own spreadsheet has, and a
    // row in Bo's household that happens to carry the plus-one's first name.
    const noIds = fam.map((f) =>
      withGuests(
        f,
        f.guests.map((g) => Object.assign({}, g, { id: undefined })),
      ),
    );
    const withSam = noIds.map((f) =>
      f.id === bo.familyId
        ? withGuests(f, [
            ...f.guests,
            { firstName: "Sam", lastName: "", nickname: null, eventNames: [] },
          ])
        : f,
    );
    const plan = await run(diffAgainstDb(ev, withSam, BOOTSTRAP_WEDDING_ID));
    expect(plan.guestCreates.map((g) => g.firstName)).toEqual(["Sam"]);
    expect(plan.guestUpdates.map((g) => g.id)).not.toContain(samId);
    expect(plan.guestRemoves.map((g) => g.id)).not.toContain(samId);
  });
});

describe("diffAgainstDb + applyImport — statement shape with plus-ones", () => {
  it("binds the RSVP-loss read's guest ids as one parameter, however many are removed", async () => {
    const { db, bo, run } = setUp();
    const { ev, fam } = await draftOf(db);
    const withoutBo = fam.map((f) =>
      withGuests(
        f,
        f.guests.filter((g) => g.id !== bo.id),
      ),
    );
    const recorded = recordStatements(db);
    await run(diffAgainstDb(ev, withoutBo, BOOTSTRAP_WEDDING_ID, EDITOR));
    const rsvpRead = recorded.find((r) => /from "rsvps"/i.test(r.sql));
    expect(rsvpRead?.sql).toContain("json_each");
    expect(rsvpRead?.sql.match(/\?/g)).toHaveLength(1);
  });

  it("issues no delete of its own for a plus-one the inviter's delete cascades", async () => {
    const { db, bo, samId, run } = setUp();
    const { ev, fam } = await draftOf(db);
    const withoutBo = fam.map((f) =>
      withGuests(
        f,
        f.guests.filter((g) => g.id !== bo.id),
      ),
    );
    const plan = await run(diffAgainstDb(ev, withoutBo, BOOTSTRAP_WEDDING_ID, EDITOR));
    expect(plan.guestRemoves.find((g) => g.id === samId)?.cascaded).toBe(true);

    const recorded = recordStatements(db);
    const summary = await run(applyImport("chg_cascade", plan, BOOTSTRAP_WEDDING_ID));
    expect(recorded.filter((r) => /^delete from "guests"/i.test(r.sql))).toHaveLength(1);
    expect(summary.guestsRemoved).toBe(2);
    expect(db.select().from(guests).where(eq(guests.id, samId)).all()).toEqual([]);
  });
});
