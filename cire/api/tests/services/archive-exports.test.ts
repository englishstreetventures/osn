import { describe, expect, it } from "bun:test";

import {
  events,
  families,
  guestEvents,
  guests,
  registryItems,
  rsvps,
  seatingAssignments,
  seatingPlans,
  seatingTables,
  vendors,
  weddingFaqs,
  weddingInviteCustomisations,
} from "@cire/db";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { EffectDbService, effectDbFor } from "../../src/db/effect-handle";
import { localD1Binding } from "../../src/db/local-d1";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import {
  MAX_REGISTRY_EXPORT_ROWS,
  registryExportService,
} from "../../src/services/registry-export";
import { MAX_HOUSEHOLD_EXPORT_ROWS, rosterExportService } from "../../src/services/roster-export";
import { MAX_SEATING_EXPORT_ROWS, seatingExportService } from "../../src/services/seating-export";
import {
  MAX_QUESTION_EXPORT_ROWS,
  settingsExportService,
} from "../../src/services/settings-export";
import { MAX_VENDOR_EXPORT_ROWS, vendorExportService } from "../../src/services/vendor-export";
import { recordStatements } from "../test-helpers";
import { insertWedding } from "../test-helpers/wedding";

/**
 * B8 in `NEW-FEAT.md`: each file the archive adds stops its read one row past
 * its ceiling, in the database, so a wedding holding more never makes the
 * Worker receive, sort or print a row the file would not hold.
 */

const W = "w1";
const now = new Date("2026-10-01T00:00:00Z");

/** Inserts `rows` in chunks bun:sqlite's bound-parameter limit allows. */
function insertAll<T>(db: TestDb, table: Parameters<TestDb["insert"]>[0], rows: T[]) {
  for (let i = 0; i < rows.length; i += 200) {
    db.insert(table)
      .values(rows.slice(i, i + 200) as never)
      .run();
  }
}

function run<A>(db: TestDb, effect: Effect.Effect<A, never, DbService | EffectDbService>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provideService(DbService, db),
      Effect.provideService(EffectDbService, effectDbFor(localD1Binding(db.$client), "fetch")),
    ),
  );
}

const cases: {
  file: string;
  ceiling: number;
  table: string;
  seed: (db: TestDb, n: number) => void;
  build: (weddingId: string) => Effect.Effect<string, never, DbService | EffectDbService>;
}[] = [
  {
    file: "households.csv",
    ceiling: MAX_HOUSEHOLD_EXPORT_ROWS,
    table: '"families"',
    seed: (db, n) =>
      insertAll(
        db,
        families,
        Array.from({ length: n }, (_, i) => ({
          id: `fam_${i}`,
          weddingId: W,
          publicId: `CODE-${i}`,
          familyName: `Family ${i}`,
          createdAt: now,
          updatedAt: now,
        })),
      ),
    build: rosterExportService.householdsCsv,
  },
  {
    file: "vendors.csv",
    ceiling: MAX_VENDOR_EXPORT_ROWS,
    table: '"vendors"',
    seed: (db, n) =>
      insertAll(
        db,
        vendors,
        Array.from({ length: n }, (_, i) => ({
          id: `ven_${i}`,
          weddingId: W,
          name: `Vendor ${i}`,
          category: "florist",
          createdAt: now,
          updatedAt: now,
        })),
      ),
    build: vendorExportService.vendorsCsv,
  },
  {
    file: "registry.csv",
    ceiling: MAX_REGISTRY_EXPORT_ROWS,
    table: '"registry_items"',
    seed: (db, n) =>
      insertAll(
        db,
        registryItems,
        Array.from({ length: n }, (_, i) => ({
          id: `ritem_${i}`,
          weddingId: W,
          title: `Item ${i}`,
          createdAt: now,
          updatedAt: now,
        })),
      ),
    build: registryExportService.itemsCsv,
  },
  {
    file: "questions.csv",
    ceiling: MAX_QUESTION_EXPORT_ROWS,
    table: '"wedding_faqs"',
    seed: (db, n) =>
      insertAll(
        db,
        weddingFaqs,
        Array.from({ length: n }, (_, i) => ({
          id: `faq_${i}`,
          weddingId: W,
          question: `Q ${i}`,
          answer: `A ${i}`,
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        })),
      ),
    build: settingsExportService.questionsCsv,
  },
  {
    file: "seating-plans.csv",
    ceiling: MAX_SEATING_EXPORT_ROWS,
    table: '"seating_tables"',
    seed: (db, n) => {
      db.insert(events)
        .values({
          id: "evt_1",
          weddingId: W,
          slug: "reception",
          name: "Reception",
          startAt: "2027-01-01T18:00",
          endAt: "",
          timezone: "UTC",
        })
        .run();
      db.insert(seatingPlans)
        .values({
          id: "spl_1",
          weddingId: W,
          eventId: "evt_1",
          name: "Plan 1",
          selected: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      insertAll(
        db,
        seatingTables,
        Array.from({ length: n }, (_, i) => ({
          id: `stb_${i}`,
          weddingId: W,
          eventId: "evt_1",
          planId: "spl_1",
          name: `Table ${i}`,
          capacity: 8,
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        })),
      );
    },
    build: seatingExportService.allPlansCsv,
  },
];

describe("B8: each archive file stops its read one row past its ceiling", () => {
  for (const { file, ceiling, table, seed, build } of cases) {
    it(file, async () => {
      const db = createDb(":memory:");
      insertWedding(db, { id: W, slug: "w1", displayName: "One", owners: ["usr_owner"] });
      seed(db, ceiling + 2);
      const statements = recordStatements(db);
      const csv = await run(db, build(W));
      const reads = statements.filter((s) => s.sql.includes(table));
      expect(reads.map((s) => s.rowCounts)).toEqual([[ceiling + 1]]);
      // The header and the ceiling's rows; no cell here holds a line break.
      expect(csv.trimEnd().split("\r\n")).toHaveLength(ceiling + 1);
    });
  }
});

/**
 * B10 in `NEW-FEAT.md`: each file the archive adds prints every column from its
 * own field, so no part of what a couple takes away is dropped or swapped.
 */
describe("B10: each archive file prints every column from its own field", () => {
  const at = new Date("2026-09-01T10:00:00Z");

  function wedding() {
    const db = createDb(":memory:");
    insertWedding(db, {
      id: W,
      slug: "ama-jonah",
      displayName: "Ama & Jonah",
      owners: ["usr_owner"],
      weddingDate: "2027-03-20",
      guestCountEstimate: 120,
      currency: "AUD",
      budgetTotalMinor: 2_500_000,
      rsvpDeadline: "2027-02-01",
      rsvpDeadlineTimezone: "Australia/Sydney",
      codeStyle: "simple",
      tier: "gold",
      createdAt: at,
    });
    return db;
  }

  it("wedding.csv", async () => {
    const db = wedding();
    expect(await run(db, settingsExportService.weddingCsv(W))).toBe(
      [
        "Field,Value",
        "Name,Ama & Jonah",
        "Invite address,ama-jonah",
        "Wedding date,2027-03-20",
        "Guests expected,120",
        "Currency,AUD",
        "Budget total,25000.00",
        "RSVP by,2027-02-01",
        "RSVP time zone,Australia/Sydney",
        "Household codes,Simple",
        "Plan,Gold",
        "Created,2026-09-01T10:00:00.000Z",
      ].join("\r\n"),
    );
  });

  it("invite.csv", async () => {
    const db = wedding();
    db.insert(weddingInviteCustomisations)
      .values({
        weddingId: W,
        designId: "gala",
        envelopeId: "wax-seal",
        heroTitle: "Ama & Jonah",
        heroSubtitle: "Sydney",
        heroVisible: false,
        storyEyebrow: "Us",
        storyHeading: "How we met",
        storyBody: "At a library.",
        storyVisible: true,
        detailsEyebrow: "When",
        detailsHeading: "The day",
        welcomeMessage: "Welcome",
        registryEyebrow: "Gifts",
        registryHeading: "Our list",
        registryBody: "No gifts needed.",
        footerMessage: "See you",
        footerVisible: false,
        faqVisible: true,
        inviteMessage: "Join us",
        themeHeadingFont: "serif-a",
        themeHeadingSize: "lg",
        themeHeadingWeight: "600",
        themeHeadingStyle: "italic",
        themeBodyFont: "sans-b",
        themeBodyWeight: "400",
        themeBodyStyle: "normal",
        palettePreset: "dusk",
        paletteGround: "#111111",
        paletteCard: "#222222",
        paletteInk: "#333333",
        paletteGilt: "#444444",
        paletteBloom: "#555555",
        heroImageKey: "assets/w1/hero-1",
        updatedAt: at,
      })
      .run();
    expect(await run(db, settingsExportService.inviteCsv(W))).toBe(
      [
        "Field,Value",
        "Design,gala",
        "Envelope,wax-seal",
        "Hero title,Ama & Jonah",
        "Hero subtitle,Sydney",
        "Hero shown,No",
        "Story eyebrow,Us",
        "Story heading,How we met",
        "Story,At a library.",
        "Story shown,Yes",
        "Details eyebrow,When",
        "Details heading,The day",
        "Welcome message,Welcome",
        "Gift list eyebrow,Gifts",
        "Gift list heading,Our list",
        "Gift list text,No gifts needed.",
        "Footer message,See you",
        "Footer shown,No",
        "Questions shown,Yes",
        "Invite message,Join us",
        "Heading font,serif-a",
        "Heading size,lg",
        "Heading weight,600",
        "Heading style,italic",
        "Body font,sans-b",
        "Body weight,400",
        "Body style,normal",
        "Palette,dusk",
        "Ground colour,#111111",
        "Card colour,#222222",
        "Ink colour,#333333",
        "Gilt colour,#444444",
        "Bloom colour,#555555",
      ].join("\r\n"),
    );
  });

  it("wedding.csv and invite.csv leave a setting nobody chose empty", async () => {
    const db = createDb(":memory:");
    insertWedding(db, {
      id: W,
      slug: "plain",
      displayName: "Plain",
      owners: ["usr_owner"],
      createdAt: at,
    });
    db.insert(weddingInviteCustomisations).values({ weddingId: W, updatedAt: at }).run();
    expect(await run(db, settingsExportService.weddingCsv(W))).toBe(
      [
        "Field,Value",
        "Name,Plain",
        "Invite address,plain",
        "Wedding date,",
        "Guests expected,",
        "Currency,AUD",
        "Budget total,",
        "RSVP by,",
        "RSVP time zone,",
        "Household codes,Secure",
        "Plan,Ivory",
        "Created,2026-09-01T10:00:00.000Z",
      ].join("\r\n"),
    );
    const invite = (await run(db, settingsExportService.inviteCsv(W))).split("\r\n");
    expect(invite).toContain("Envelope,");
    expect(invite).toContain("Hero title,");
    expect(invite).toContain("Hero shown,Yes");
  });

  it("wedding.csv and invite.csv for a wedding with no row print the header alone", async () => {
    const db = createDb(":memory:");
    expect(await run(db, settingsExportService.weddingCsv("w_none"))).toBe("Field,Value");
    expect(await run(db, settingsExportService.inviteCsv("w_none"))).toBe("Field,Value");
  });

  it("questions.csv", async () => {
    const db = wedding();
    insertAll(db, weddingFaqs, [
      {
        id: "faq_b",
        weddingId: W,
        question: "Parking?",
        answer: "Yes",
        sortOrder: 1,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "faq_a",
        weddingId: W,
        question: "Dress code?",
        answer: "Formal",
        sortOrder: 0,
        createdAt: at,
        updatedAt: at,
      },
    ]);
    expect(await run(db, settingsExportService.questionsCsv(W))).toBe(
      ["Question,Answer", "Dress code?,Formal", "Parking?,Yes"].join("\r\n"),
    );
  });

  it("households.csv", async () => {
    const db = wedding();
    insertAll(db, families, [
      {
        id: "fam_b",
        weddingId: W,
        publicId: "B-CODE",
        familyName: "Bell",
        codeSharedAt: new Date("2026-09-02T00:00:00Z"),
        firstOpenedAt: new Date("2026-09-03T00:00:00Z"),
        deactivatedAt: new Date("2026-09-04T00:00:00Z"),
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "fam_a",
        weddingId: W,
        publicId: "A-CODE",
        familyName: "Ash",
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "fam_host",
        weddingId: W,
        publicId: "HOST-CODE",
        familyName: "Host",
        kind: "host",
        createdAt: at,
        updatedAt: at,
      },
    ]);
    insertAll(db, guests, [
      { id: "g1", familyId: "fam_a", firstName: "Ada", createdAt: at, updatedAt: at },
      { id: "g2", familyId: "fam_a", firstName: "Abe", createdAt: at, updatedAt: at },
    ]);
    expect(await run(db, rosterExportService.householdsCsv(W))).toBe(
      [
        "Family Code,Family Name,Guests,Code Sent,First Opened,Code Status,Added",
        "A-CODE,Ash,2,,,Active,2026-09-01T10:00:00.000Z",
        "B-CODE,Bell,0,2026-09-02T00:00:00.000Z,2026-09-03T00:00:00.000Z,Deactivated,2026-09-01T10:00:00.000Z",
      ].join("\r\n"),
    );
  });

  it("vendors.csv", async () => {
    const db = wedding();
    insertAll(db, vendors, [
      {
        id: "ven_b",
        weddingId: W,
        name: "Bloom Co",
        category: "florals",
        status: "booked",
        sortOrder: 0,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "ven_a",
        weddingId: W,
        name: "Hall",
        category: "venue",
        status: "researching",
        contactName: "Kim",
        email: "kim@example.test",
        phone: "0400 000 000",
        quotedMinor: 1_234_56,
        notes: "Has parking",
        sortOrder: 0,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "ven_c",
        weddingId: W,
        name: "Odd",
        category: "unlisted",
        status: "contacted",
        sortOrder: 0,
        createdAt: at,
        updatedAt: at,
      },
    ]);
    expect(await run(db, vendorExportService.vendorsCsv(W))).toBe(
      [
        "Vendor,Category,Stage,Contact,Email,Phone,Quoted,Currency,Notes,Added",
        "Hall,Venue,Researching,Kim,kim@example.test,0400 000 000,1234.56,AUD,Has parking,2026-09-01T10:00:00.000Z",
        "Odd,unlisted,Contacted,,,,,AUD,,2026-09-01T10:00:00.000Z",
        "Bloom Co,Florals,Booked,,,,,AUD,,2026-09-01T10:00:00.000Z",
      ].join("\r\n"),
    );
  });

  it("registry.csv", async () => {
    const db = wedding();
    insertAll(db, registryItems, [
      {
        id: "ritem_b",
        weddingId: W,
        kind: "cash_fund",
        title: "Honeymoon",
        targetMinor: 300_000,
        allowPartial: true,
        sortOrder: 1,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "ritem_a",
        weddingId: W,
        title: "Vase",
        description: "Blue",
        category: "Home",
        priceMinor: 4_500,
        quantityWanted: 2,
        externalUrl: "https://shop.example.test/vase",
        sortOrder: 0,
        createdAt: at,
        updatedAt: at,
      },
    ]);
    expect(await run(db, registryExportService.itemsCsv(W))).toBe(
      [
        "Gift,Kind,Category,Description,Price,Wanted,Group Gift,Target,Currency,Link",
        "Vase,Gift,Home,Blue,45.00,2,No,,AUD,https://shop.example.test/vase",
        "Honeymoon,Fund,,,,1,Yes,3000.00,AUD,",
      ].join("\r\n"),
    );
  });

  it("seating-plans.csv", async () => {
    const db = wedding();
    db.insert(events)
      .values({
        id: "evt_1",
        weddingId: W,
        slug: "reception",
        name: "Reception",
        startAt: "2027-03-20T18:00",
        endAt: "",
        timezone: "UTC",
      })
      .run();
    insertAll(db, families, [
      { id: "fam_a", weddingId: W, publicId: "A", familyName: "Ash", createdAt: at, updatedAt: at },
      {
        id: "fam_b",
        weddingId: W,
        publicId: "B",
        familyName: "Bell",
        deactivatedAt: at,
        createdAt: at,
        updatedAt: at,
      },
    ]);
    insertAll(db, guests, [
      {
        id: "g_yes",
        familyId: "fam_a",
        firstName: "Ada",
        lastName: "Ash",
        sortOrder: 0,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "g_no",
        familyId: "fam_a",
        firstName: "Abe",
        lastName: "Ash",
        sortOrder: 1,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "g_maybe",
        familyId: "fam_a",
        firstName: "Amy",
        lastName: "Ash",
        sortOrder: 2,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "g_none",
        familyId: "fam_a",
        firstName: "Art",
        lastName: "Ash",
        sortOrder: 3,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "g_gone",
        familyId: "fam_b",
        firstName: "Bo",
        lastName: "Bell",
        sortOrder: 0,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "g_mono",
        familyId: "fam_a",
        firstName: "Cher",
        lastName: "",
        sortOrder: 4,
        createdAt: at,
        updatedAt: at,
      },
    ]);
    insertAll(
      db,
      guestEvents,
      ["g_yes", "g_no", "g_maybe", "g_none", "g_gone", "g_mono"].map((guestId) => ({
        guestId,
        eventId: "evt_1",
      })),
    );
    insertAll(db, rsvps, [
      { id: "r1", guestId: "g_yes", eventId: "evt_1", status: "attending", createdAt: at },
      { id: "r2", guestId: "g_no", eventId: "evt_1", status: "declined", createdAt: at },
      { id: "r3", guestId: "g_maybe", eventId: "evt_1", status: "maybe", createdAt: at },
    ]);
    insertAll(db, seatingPlans, [
      {
        id: "spl_a",
        weddingId: W,
        eventId: "evt_1",
        name: "Plan A",
        selected: true,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "spl_b",
        weddingId: W,
        eventId: "evt_1",
        name: "Plan B",
        selected: false,
        createdAt: new Date("2026-09-02T00:00:00Z"),
        updatedAt: at,
      },
    ]);
    insertAll(db, seatingTables, [
      {
        id: "t1",
        weddingId: W,
        eventId: "evt_1",
        planId: "spl_a",
        name: "Table 1",
        capacity: 8,
        sortOrder: 0,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "t2",
        weddingId: W,
        eventId: "evt_1",
        planId: "spl_b",
        name: "Long table",
        capacity: 20,
        sortOrder: 0,
        createdAt: at,
        updatedAt: at,
      },
    ]);
    insertAll(db, seatingAssignments, [
      { tableId: "t1", planId: "spl_a", eventId: "evt_1", guestId: "g_yes", createdAt: at },
      { tableId: "t1", planId: "spl_a", eventId: "evt_1", guestId: "g_no", createdAt: at },
      { tableId: "t1", planId: "spl_a", eventId: "evt_1", guestId: "g_maybe", createdAt: at },
      { tableId: "t1", planId: "spl_a", eventId: "evt_1", guestId: "g_none", createdAt: at },
      { tableId: "t1", planId: "spl_a", eventId: "evt_1", guestId: "g_gone", createdAt: at },
      { tableId: "t1", planId: "spl_a", eventId: "evt_1", guestId: "g_mono", createdAt: at },
    ]);
    expect(await run(db, seatingExportService.allPlansCsv(W))).toBe(
      [
        "Event,Plan,In Use,Table,Capacity,Guest,Household,RSVP",
        "Reception,Plan A,Yes,Table 1,8,Ada Ash,Ash,Attending",
        "Reception,Plan A,Yes,Table 1,8,Abe Ash,Ash,Declined",
        "Reception,Plan A,Yes,Table 1,8,Amy Ash,Ash,Maybe",
        "Reception,Plan A,Yes,Table 1,8,Art Ash,Ash,No reply",
        "Reception,Plan A,Yes,Table 1,8,Cher,Ash,No reply",
        "Reception,Plan A,Yes,Table 1,8,Bo Bell,Bell,Invite withdrawn",
        "Reception,Plan B,No,Long table,20,,,",
      ].join("\r\n"),
    );
  });
});
