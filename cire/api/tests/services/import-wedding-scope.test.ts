import { describe, it, expect } from "bun:test";

import { guestEvents, guests } from "@cire/db";
import { and, eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import type { ImportPlan, ParsedEvent } from "../../src/schemas/import";
import { applyImport } from "../../src/services/import";
import type { ApplyImportOptions } from "../../src/services/import";
import { BASE_GUEST_CAP } from "../../src/services/tiers";
import { setTier } from "../test-helpers";
import { fullWeddingStatements, WEDDING_CHILD_TABLES } from "../test-helpers/full-wedding";

/**
 * `applyImport` writes only the wedding it is given, whatever plan it is
 * handed. Every plan reaching it today is built from that wedding's own reads,
 * so these tests build plans by hand: each names one of wedding B's rows and is
 * applied under wedding A's id. Every statement in the write set carries A's
 * scope itself, so nothing in B changes. An update or delete of B's row matches
 * nothing; an insert whose parent is B's is refused, as an insert whose parent
 * does not exist is.
 *
 * The same plan applied under B's own id does change B — the control that shows
 * each plan reaches a real row, so it was the scope that stopped it.
 */

const A = "wed_a";
const B = "wed_b";
const family = (w: string) => `fam_${w}`;
const guest = (w: string) => `gst_${w}`;
const event = (w: string) => `evt_${w}`;
/** A second event in each wedding, with no invitations. */
const event2 = (w: string) => `evt2_${w}`;

/** Two weddings with a household, a guest with an address, an event with an
 *  invitation, an RSVP, a run of show and seating, and an uninvited event. */
function twoWeddings(): TestDb {
  const db = createDb(":memory:");
  for (const w of [A, B]) {
    for (const statement of fullWeddingStatements(w)) db.run(statement);
    db.run(
      sql`INSERT INTO events (id, wedding_id, slug, name, start_at, end_at, timezone, sort_order) VALUES (${event2(w)}, ${w}, 'reception', 'Reception', '2027-01-01T18:00', '2027-01-01T23:00', 'UTC', 1)`,
    );
  }
  return db;
}

/** Every row of every table a wedding's data lives in, sorted per table. */
function dump(db: TestDb): Record<string, string[]> {
  return Object.fromEntries(
    ["weddings", ...WEDDING_CHILD_TABLES].map((table) => [
      table,
      db.$client
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row))
        .toSorted(),
    ]),
  );
}

const plan = (ops: Partial<ImportPlan>): ImportPlan => ({
  eventCreates: [],
  eventUpdates: [],
  eventRemoves: [],
  familyCreates: [],
  familyUpdates: [],
  familyRemoves: [],
  guestCreates: [],
  guestUpdates: [],
  guestRemoves: [],
  eventLinkCreates: [],
  eventLinkRemoves: [],
  warnings: [],
  ...ops,
});

const ceremony = (fields: Partial<ParsedEvent> = {}): ParsedEvent => ({
  name: "Ceremony",
  startAt: "2027-01-01T10:00",
  endAt: "2027-01-01T11:00",
  timezone: "UTC",
  address: null,
  dressCodeDescription: null,
  dressCodePalette: [],
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
  ...fields,
});

const newGuest = (id: string, familyId: string) => ({
  id,
  familyId,
  firstName: "Cy",
  lastName: "",
  nickname: null,
  sortOrder: 5,
});

const STAMP: ApplyImportOptions = {
  emailStamp: { osnProfileId: "usr_owner", version: "test-attestation" },
};

function apply(db: TestDb, p: ImportPlan, weddingId: string, options?: ApplyImportOptions) {
  return Effect.runPromiseExit(
    applyImport("chg_scope", p, weddingId, [], options).pipe(Effect.provideService(DbService, db)),
  );
}

type Outcome = "applied" | "refused";

/** What the apply came to: written, or refused by a failed write with no
 *  capacity attached. Anything else fails the test. */
function outcome(exit: Exit.Exit<unknown, unknown>): Outcome {
  if (Exit.isSuccess(exit)) return "applied";
  const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  expect(failure).toMatchObject({ _tag: "ImportError", reason: "apply failed" });
  expect((failure as { capacity?: unknown }).capacity).toBeUndefined();
  return "refused";
}

interface Case {
  /** The failure mode it pins. */
  name: string;
  plan: ImportPlan;
  /** What the apply comes to under A's id. */
  underA: Outcome;
  options?: ApplyImportOptions;
  /** Rows to add before the apply. */
  seed?: (db: TestDb) => void;
  /** Whether the same plan under B's own id changes B. False only where the
   *  plan names a row of both weddings, or B's own id refuses it too. */
  control: boolean;
}

const CASES: Case[] = [
  {
    name: "an event remove naming B's event deletes none of its RSVPs, invitations, seats or run of show",
    plan: plan({ eventRemoves: [{ id: event(B), name: "Ceremony" }] }),
    underA: "applied",
    control: true,
  },
  {
    name: "an event update naming B's event rewrites nothing",
    plan: plan({
      eventUpdates: [{ id: event(B), event: ceremony({ name: "Moved", sortOrder: 7 }) }],
    }),
    underA: "applied",
    control: true,
  },
  {
    name: "an event update restating B's event's run of show writes no item onto it",
    plan: plan({
      eventUpdates: [
        { id: event(B), event: ceremony({ runOfShow: [{ time: "17:00", label: "Toasts" }] }) },
      ],
    }),
    underA: "refused",
    control: true,
  },
  {
    name: "a household remove naming B's household deletes nothing",
    plan: plan({ familyRemoves: [{ id: family(B), familyName: "Family" }] }),
    underA: "applied",
    control: true,
  },
  {
    name: "a household rename naming B's household renames nothing",
    plan: plan({ familyUpdates: [{ id: family(B), familyName: "Renamed" }] }),
    underA: "applied",
    control: true,
  },
  {
    name: "a guest remove naming B's guest deletes nothing",
    plan: plan({ guestRemoves: [{ id: guest(B), firstName: "Ada" }] }),
    underA: "applied",
    control: true,
  },
  {
    name: "a guest update naming B's guest rewrites nothing",
    plan: plan({
      guestUpdates: [
        { id: guest(B), firstName: "Bea", lastName: "Other", nickname: "B", sortOrder: 9 },
      ],
    }),
    underA: "applied",
    control: true,
  },
  {
    name: "an address write naming B's guest replaces no address",
    plan: plan({
      emailWrites: [
        {
          guestId: guest(B),
          email: "taken@example.test",
          emailHash: "hash_taken",
          emailWas: "ada@example.test",
          emailSourceWas: "guest",
        },
      ],
    }),
    options: STAMP,
    underA: "applied",
    control: true,
  },
  {
    name: "a guest create naming B's household is refused",
    plan: plan({ guestCreates: [newGuest("gst_new", family(B))] }),
    underA: "refused",
    control: true,
  },
  {
    name: "an invitation remove naming B's guest and event deletes nothing",
    plan: plan({ eventLinkRemoves: [{ guestId: guest(B), eventId: event(B) }] }),
    underA: "applied",
    control: true,
  },
  {
    name: "an invitation remove deletes no link that crosses into B, by its guest or its event",
    plan: plan({
      eventLinkRemoves: [
        { guestId: guest(A), eventId: event(B) },
        { guestId: guest(B), eventId: event(A) },
      ],
    }),
    seed: (db) => {
      db.insert(guestEvents)
        .values([
          { guestId: guest(A), eventId: event(B) },
          { guestId: guest(B), eventId: event(A) },
        ])
        .run();
    },
    underA: "applied",
    control: false,
  },
  {
    name: "an invitation create naming B's guest and event is refused",
    plan: plan({ eventLinkCreates: [{ guestId: guest(B), eventId: event2(B) }] }),
    underA: "refused",
    control: true,
  },
  {
    name: "an invitation create for A's guest to B's event is refused",
    plan: plan({ eventLinkCreates: [{ guestId: guest(A), eventId: event2(B) }] }),
    underA: "refused",
    control: false,
  },
  {
    name: "an invitation create for B's guest to A's event is refused",
    plan: plan({ eventLinkCreates: [{ guestId: guest(B), eventId: event2(A) }] }),
    underA: "refused",
    control: false,
  },
  {
    name: "an event create reusing B's event id is refused",
    plan: plan({ eventCreates: [{ id: event(B), event: ceremony({ name: "Clash" }) }] }),
    underA: "refused",
    control: false,
  },
  {
    name: "a household create reusing B's household id is refused",
    plan: plan({
      familyCreates: [{ id: family(B), publicId: "CLASH-0001", familyName: "Clash" }],
    }),
    underA: "refused",
    control: false,
  },
];

describe("applyImport under one wedding's id writes nothing in another", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const db = twoWeddings();
      c.seed?.(db);
      const before = dump(db);

      expect(outcome(await apply(db, c.plan, A, c.options))).toBe(c.underA);
      expect(dump(db)).toEqual(before);

      if (c.control) {
        expect(outcome(await apply(db, c.plan, B, c.options))).toBe("applied");
        expect(dump(db)).not.toEqual(before);
      }
    });
  }

  it("a guest create naming B's household is refused as such, not as a full wedding, when A is at its cap", async () => {
    const db = twoWeddings();
    setTier(db, A, "ivory");
    // The fixture's one guest and these fill A to the cap.
    for (let i = 1; i < BASE_GUEST_CAP; i++) {
      db.run(
        sql`INSERT INTO guests (id, family_id, first_name, created_at, updated_at) VALUES (${`gst_fill_${i}`}, ${family(A)}, 'Fill', 1, 1)`,
      );
    }
    // Each plan carries a cap above the live one, so the check before the
    // write passes and the insert itself checks the cap.
    const into = (familyId: string) =>
      plan({ guestCreates: [newGuest("gst_new", familyId)], derivedCap: BASE_GUEST_CAP * 5 });
    const before = dump(db);

    // A is full: a guest of its own is refused as a full wedding.
    const full = await apply(db, into(family(A)), A);
    expect(
      Exit.isFailure(full) ? Option.getOrUndefined(Cause.findErrorOption(full.cause)) : undefined,
    ).toMatchObject({ _tag: "ImportError", capacity: { limit: BASE_GUEST_CAP } });
    expect(dump(db)).toEqual(before);

    expect(outcome(await apply(db, into(family(B)), A))).toBe("refused");
    expect(dump(db)).toEqual(before);
  });

  it("the wedding's own rows still write: existing ones, and ones the same plan creates", async () => {
    const db = twoWeddings();
    const exit = await apply(
      db,
      plan({
        eventCreates: [{ id: "evt_new", event: ceremony({ name: "Brunch", sortOrder: 5 }) }],
        familyCreates: [{ id: "fam_new", publicId: "NEW-0001", familyName: "New" }],
        guestCreates: [newGuest("gst_in_new", "fam_new"), newGuest("gst_in_old", family(A))],
        eventLinkRemoves: [{ guestId: guest(A), eventId: event(A) }],
        eventLinkCreates: [
          { guestId: "gst_in_new", eventId: "evt_new" },
          { guestId: guest(A), eventId: event2(A) },
        ],
      }),
      A,
    );

    expect(outcome(exit)).toBe("applied");
    expect(
      db
        .select({ id: guests.id, familyId: guests.familyId, firstName: guests.firstName })
        .from(guests)
        .where(sql`${guests.id} IN ('gst_in_new', 'gst_in_old')`)
        .all()
        .toSorted((x, y) => x.id.localeCompare(y.id)),
    ).toEqual([
      { id: "gst_in_new", familyId: "fam_new", firstName: "Cy" },
      { id: "gst_in_old", familyId: family(A), firstName: "Cy" },
    ]);
    const links = db
      .select()
      .from(guestEvents)
      .where(sql`${guestEvents.guestId} IN ('gst_in_new', ${guest(A)})`)
      .all()
      .toSorted((x, y) => x.guestId.localeCompare(y.guestId) || x.eventId.localeCompare(y.eventId));
    expect(links).toEqual([
      { guestId: "gst_in_new", eventId: "evt_new" },
      { guestId: guest(A), eventId: event2(A) },
    ]);
    expect(
      db
        .select()
        .from(guestEvents)
        .where(and(eq(guestEvents.guestId, guest(A)), eq(guestEvents.eventId, event(A))))
        .all(),
    ).toEqual([]);
  });
});
