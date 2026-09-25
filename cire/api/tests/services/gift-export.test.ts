import { describe, it, expect } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  families,
  registryClaims,
  registryContributions,
  registryItems,
  weddings,
} from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Logger, References } from "effect";

import type { Db } from "../../src/db";
import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { minorToDecimal } from "../../src/lib/money";
import { MAX_GIFT_EXPORT_ROWS, giftExportService } from "../../src/services/gift-export";
import { registryService } from "../../src/services/registry";
import type { GiftLogEntryDto } from "../../src/services/registry";
import { TestDbLayer } from "../db/test-layer";
import { effWith, recordStatements } from "../test-helpers";

const withDb = effWith(TestDbLayer);

/** Split a CSV document into lines (CRLF, per RFC 4180). */
const lines = (csv: string) => csv.split("\r\n");

/** Fixed clock for the seeds — column order is asserted, so it must be stable. */
const at = (minutes: number) => new Date(Date.UTC(2026, 7, 20, 10, minutes, 0));

/**
 * One household and one gift-list item on the bootstrap wedding.
 *
 * The seed's own families carry generated ids (`setup.ts` uses
 * `crypto.randomUUID()`), so a test that needs to name a family in an assertion
 * has to insert its own.
 */
function seedHousehold(db: Db) {
  db.insert(families)
    .values({
      id: "fam_gifts",
      weddingId: BOOTSTRAP_WEDDING_ID,
      publicId: "GIFT-AAA-0001",
      familyName: "Marchetti",
      createdAt: at(0),
      updatedAt: at(0),
    })
    .run();
  db.insert(registryItems)
    .values({
      id: "ritem_pan",
      weddingId: BOOTSTRAP_WEDDING_ID,
      title: "Copper Pan",
      createdAt: at(0),
      updatedAt: at(0),
    })
    .run();
}

/** A logger layer with no loggers, for tests that do not read the log. */
const silent = Logger.layer([]);

/** Rows per insert statement, to stay well under SQLite's bound-variable cap. */
const CHUNK = 100;

/**
 * `total` gifts for the `seedHousehold` family, alternating by age: index 0 is
 * the oldest, even indices are cash gifts and odd ones are claims, each claim
 * on its own item (one household can claim an item once). Each row's note is
 * `row-<index>` and its time is `at(index)`, so every row is distinct and its
 * age can be read back from the file.
 */
function seedOverflow(db: Db, total: number) {
  const indices = Array.from({ length: total }, (_, i) => i);
  const odd = indices.filter((i) => i % 2 === 1);
  const even = indices.filter((i) => i % 2 === 0);
  for (let start = 0; start < odd.length; start += CHUNK) {
    const slice = odd.slice(start, start + CHUNK);
    db.insert(registryItems)
      .values(
        slice.map((i) => ({
          id: `ritem_bulk_${i}`,
          weddingId: BOOTSTRAP_WEDDING_ID,
          title: `Item ${i}`,
          createdAt: at(0),
          updatedAt: at(0),
        })),
      )
      .run();
    db.insert(registryClaims)
      .values(
        slice.map((i) => ({
          id: `rclaim_bulk_${i}`,
          weddingId: BOOTSTRAP_WEDDING_ID,
          itemId: `ritem_bulk_${i}`,
          familyId: "fam_gifts",
          quantity: 1,
          status: "purchased" as const,
          note: `row-${i}`,
          createdAt: at(i),
          updatedAt: at(i),
        })),
      )
      .run();
  }
  for (let start = 0; start < even.length; start += CHUNK) {
    db.insert(registryContributions)
      .values(
        even.slice(start, start + CHUNK).map((i) => ({
          id: `rcon_bulk_${i}`,
          weddingId: BOOTSTRAP_WEDDING_ID,
          familyId: "fam_gifts",
          status: "succeeded" as const,
          amountMinor: 100,
          currency: "AUD",
          message: `row-${i}`,
          createdAt: at(i),
          updatedAt: at(i),
        })),
      )
      .run();
  }
}

/**
 * One row for every branch the gift log and the export must agree on: each
 * claim status, each contribution status (`failed` is the one both hide), a
 * gift from the host household, a cash gift whose item was deleted afterwards,
 * one in another currency with the snapshotted conversion, and two gifts on a
 * second wedding that neither side may show.
 */
function seedParity(db: Db) {
  seedHousehold(db);
  db.insert(families)
    .values({
      id: "fam_host",
      weddingId: BOOTSTRAP_WEDDING_ID,
      publicId: "HOST-BBB-0002",
      familyName: "Okonkwo",
      kind: "host",
      createdAt: at(0),
      updatedAt: at(0),
    })
    .run();
  db.insert(registryItems)
    .values(
      ["vase", "rug", "gone"].map((name) => ({
        id: `ritem_${name}`,
        weddingId: BOOTSTRAP_WEDDING_ID,
        title: name === "gone" ? "Deleted Lamp" : `The ${name}`,
        createdAt: at(0),
        updatedAt: at(0),
      })),
    )
    .run();
  db.insert(registryClaims)
    .values([
      {
        id: "rclaim_purchased",
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: "ritem_pan",
        familyId: "fam_gifts",
        quantity: 2,
        status: "purchased",
        note: "Bought the pair",
        displayName: "Auntie Ros",
        thankedAt: at(30),
        createdAt: at(1),
        updatedAt: at(30),
      },
      {
        id: "rclaim_reserved",
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: "ritem_vase",
        familyId: "fam_gifts",
        quantity: 1,
        status: "reserved",
        createdAt: at(2),
        updatedAt: at(2),
      },
      {
        id: "rclaim_released",
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: "ritem_rug",
        familyId: "fam_gifts",
        quantity: 1,
        status: "released",
        note: "Changed my mind",
        createdAt: at(3),
        updatedAt: at(3),
      },
    ])
    .run();
  const cash = (
    id: string,
    minutes: number,
    fields: Partial<typeof registryContributions.$inferInsert>,
  ) => ({
    id,
    weddingId: BOOTSTRAP_WEDDING_ID,
    familyId: "fam_gifts",
    status: "succeeded" as const,
    amountMinor: 5_000,
    currency: "AUD",
    createdAt: at(minutes),
    updatedAt: at(minutes),
    ...fields,
  });
  db.insert(registryContributions)
    .values([
      cash("rcon_general", 4, { message: "For the honeymoon", displayName: "The Marchettis" }),
      cash("rcon_pending", 5, { status: "pending", itemId: "ritem_vase" }),
      cash("rcon_disputed", 6, { status: "disputed", message: "Held by the bank" }),
      cash("rcon_refunded", 7, { status: "refunded", message: "Sent back later" }),
      cash("rcon_failed", 8, { status: "failed", message: "Card declined here" }),
      cash("rcon_host", 9, { familyId: "fam_host", message: "From us two" }),
      cash("rcon_gone", 10, { itemId: "ritem_gone", message: "Towards the lamp" }),
      cash("rcon_yen", 11, {
        amountMinor: 20_000,
        currency: "JPY",
        primaryAmountMinor: 20_400,
        primaryCurrency: "AUD",
        fxRate: "0.0102",
        thankedAt: at(40),
      }),
    ])
    .run();
  // Deleting the item sets the gift's `item_id` NULL rather than erasing it.
  db.delete(registryItems).where(eq(registryItems.id, "ritem_gone")).run();

  db.insert(weddings)
    .values({
      id: "wed_parity_other",
      slug: "parity-other",
      displayName: "Another Wedding",
      ownerOsnProfileId: "usr_parity_other",
      createdAt: at(0),
      updatedAt: at(0),
    })
    .run();
  db.insert(families)
    .values({
      id: "fam_parity_other",
      weddingId: "wed_parity_other",
      publicId: "OTHR-CCC-0003",
      familyName: "Someone Else",
      createdAt: at(0),
      updatedAt: at(0),
    })
    .run();
  db.insert(registryItems)
    .values({
      id: "ritem_parity_other",
      weddingId: "wed_parity_other",
      title: "Someone Elses Kettle",
      createdAt: at(0),
      updatedAt: at(0),
    })
    .run();
  db.insert(registryClaims)
    .values({
      id: "rclaim_parity_other",
      weddingId: "wed_parity_other",
      itemId: "ritem_parity_other",
      familyId: "fam_parity_other",
      quantity: 1,
      status: "purchased",
      createdAt: at(12),
      updatedAt: at(12),
    })
    .run();
  db.insert(registryContributions)
    .values({
      ...cash("rcon_parity_other", 13, { message: "Not your gift" }),
      weddingId: "wed_parity_other",
      familyId: "fam_parity_other",
    })
    .run();
}

/**
 * A gift-log entry written out as the export's line would be. The seeds hold
 * no comma, quote or formula marker, so no cell needs quoting or escaping.
 */
function asExportLine(e: GiftLogEntryDto): string {
  return [
    e.kind === "claim" ? "Gift list" : "Cash gift",
    e.itemTitle ?? "",
    e.familyName,
    e.displayName ?? "",
    e.quantity === null ? "" : String(e.quantity),
    e.status,
    e.note ?? "",
    e.amountMinor === null || e.currency === null ? "" : minorToDecimal(e.amountMinor, e.currency),
    e.currency ?? "",
    e.primaryAmountMinor === null || e.primaryCurrency === null
      ? ""
      : minorToDecimal(e.primaryAmountMinor, e.primaryCurrency),
    e.primaryCurrency ?? "",
    e.fxRate ?? "",
    e.thankedAt === null ? "" : new Date(e.thankedAt).toISOString(),
    new Date(e.createdAt).toISOString(),
  ].join(",");
}

describe("giftExportService.giftsCsv", () => {
  it(
    "writes the header alone when the wedding has no gifts",
    withDb(
      Effect.gen(function* () {
        const csv = yield* giftExportService.giftsCsv(BOOTSTRAP_WEDDING_ID);
        expect(lines(csv)).toEqual([
          "Kind,Item,Household,Given As,Quantity,Status,Note,Amount,Currency,Amount In Your Currency,Your Currency,Exchange Rate,Thanked At,Received At",
        ]);
      }),
    ),
  );

  it(
    "merges claims and cash gifts newest-first, with amounts as bare decimals",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        seedHousehold(db);
        db.insert(registryClaims)
          .values({
            id: "rclaim_pan",
            weddingId: BOOTSTRAP_WEDDING_ID,
            itemId: "ritem_pan",
            familyId: "fam_gifts",
            quantity: 2,
            status: "purchased",
            note: "Bought the pair",
            displayName: "Auntie Ros",
            createdAt: at(1),
            updatedAt: at(1),
          })
          .run();
        db.insert(registryContributions)
          .values({
            id: "rcon_cash",
            weddingId: BOOTSTRAP_WEDDING_ID,
            familyId: "fam_gifts",
            status: "succeeded",
            amountMinor: 12_500,
            currency: "AUD",
            message: "For the honeymoon",
            createdAt: at(2),
            updatedAt: at(2),
          })
          .run();

        const rows = lines(yield* giftExportService.giftsCsv(BOOTSTRAP_WEDDING_ID));
        expect(rows).toHaveLength(3);
        // Newest first: the cash gift landed a minute after the claim.
        expect(rows[1]).toBe(
          "Cash gift,,Marchetti,,,succeeded,For the honeymoon,125.00,AUD,,,,,2026-08-20T10:02:00.000Z",
        );
        expect(rows[2]).toBe(
          "Gift list,Copper Pan,Marchetti,Auntie Ros,2,purchased,Bought the pair,,,,,,,2026-08-20T10:01:00.000Z",
        );
      }),
    ),
  );

  it(
    "drops failed contributions but keeps refunded ones",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        seedHousehold(db);
        db.insert(registryContributions)
          .values([
            {
              id: "rcon_failed",
              weddingId: BOOTSTRAP_WEDDING_ID,
              familyId: "fam_gifts",
              status: "failed",
              amountMinor: 5000,
              currency: "AUD",
              message: "Card declined here",
              createdAt: at(1),
              updatedAt: at(1),
            },
            {
              id: "rcon_refunded",
              weddingId: BOOTSTRAP_WEDDING_ID,
              familyId: "fam_gifts",
              status: "refunded",
              amountMinor: 5000,
              currency: "AUD",
              message: "Sent back later",
              createdAt: at(2),
              updatedAt: at(2),
            },
          ])
          .run();

        const csv = yield* giftExportService.giftsCsv(BOOTSTRAP_WEDDING_ID);
        expect(csv).toContain("Sent back later");
        expect(csv).not.toContain("Card declined here");
      }),
    ),
  );

  it(
    "reads the minor-unit exponent per currency and fills the FX columns",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        seedHousehold(db);
        db.insert(registryContributions)
          .values({
            id: "rcon_yen",
            weddingId: BOOTSTRAP_WEDDING_ID,
            itemId: "ritem_pan",
            familyId: "fam_gifts",
            status: "succeeded",
            // JPY has no minor unit: 20000 minor units is ¥20,000, not ¥200.
            amountMinor: 20_000,
            currency: "JPY",
            primaryAmountMinor: 20_400,
            primaryCurrency: "AUD",
            fxRate: "0.0102",
            createdAt: at(1),
            updatedAt: at(1),
          })
          .run();

        const row = lines(yield* giftExportService.giftsCsv(BOOTSTRAP_WEDDING_ID))[1]!;
        const cells = row.split(",");
        expect(cells[1]).toBe("Copper Pan");
        expect(cells[7]).toBe("20000");
        expect(cells[8]).toBe("JPY");
        expect(cells[9]).toBe("204.00");
        expect(cells[10]).toBe("AUD");
        expect(cells[11]).toBe("0.0102");
      }),
    ),
  );

  it(
    "scopes the export to one wedding",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        seedHousehold(db);
        db.insert(registryContributions)
          .values({
            id: "rcon_mine",
            weddingId: BOOTSTRAP_WEDDING_ID,
            familyId: "fam_gifts",
            status: "succeeded",
            amountMinor: 1000,
            currency: "AUD",
            message: "Ours",
            createdAt: at(1),
            updatedAt: at(1),
          })
          .run();

        const csv = yield* giftExportService.giftsCsv("wed_someone_else");
        expect(lines(csv)).toHaveLength(1);
      }),
    ),
  );

  it(
    "escapes cells that a spreadsheet would otherwise run as a formula",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        seedHousehold(db);
        db.insert(registryClaims)
          .values({
            id: "rclaim_inject",
            weddingId: BOOTSTRAP_WEDDING_ID,
            itemId: "ritem_pan",
            familyId: "fam_gifts",
            quantity: 1,
            status: "purchased",
            note: "-1+1",
            displayName: "@evil",
            createdAt: at(1),
            updatedAt: at(1),
          })
          .run();
        db.insert(registryContributions)
          .values({
            id: "rcon_inject",
            weddingId: BOOTSTRAP_WEDDING_ID,
            familyId: "fam_gifts",
            status: "succeeded",
            amountMinor: 1000,
            currency: "AUD",
            message: "=cmd|' /C calc'!A0",
            createdAt: at(2),
            updatedAt: at(2),
          })
          .run();

        // Every one of these is guest-written text arriving in a file the couple
        // will open in Excel or Numbers, so the leading marker must be neutered
        // rather than merely quoted.
        const csv = yield* giftExportService.giftsCsv(BOOTSTRAP_WEDDING_ID);
        expect(csv).toContain("'=cmd|' /C calc'!A0");
        expect(csv).toContain("'@evil");
        expect(csv).toContain("'-1+1");
      }),
    ),
  );

  it(
    "keeps gifts given by the host household, unlike the guest export",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        db.insert(families)
          .values({
            id: "fam_host",
            weddingId: BOOTSTRAP_WEDDING_ID,
            publicId: "HOST-BBB-0002",
            familyName: "Okonkwo",
            kind: "host",
            createdAt: at(0),
            updatedAt: at(0),
          })
          .run();
        db.insert(registryContributions)
          .values({
            id: "rcon_host",
            weddingId: BOOTSTRAP_WEDDING_ID,
            familyId: "fam_host",
            status: "succeeded",
            amountMinor: 2000,
            currency: "AUD",
            message: "From us two",
            createdAt: at(1),
            updatedAt: at(1),
          })
          .run();

        // The guests export filters `kind = 'host'` out (table-export.ts:99)
        // because a host is not a guest. A gift is a gift whoever sent it, and
        // the portal's log shows it, so the export keeps it.
        const csv = yield* giftExportService.giftsCsv(BOOTSTRAP_WEDDING_ID);
        expect(csv).toContain("Okonkwo");
        expect(csv).toContain("From us two");
      }),
    ),
  );

  it(
    "prints the thanked-at date apart from the received-at date",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        seedHousehold(db);
        db.insert(registryClaims)
          .values({
            id: "rclaim_thanked",
            weddingId: BOOTSTRAP_WEDDING_ID,
            itemId: "ritem_pan",
            familyId: "fam_gifts",
            quantity: 1,
            status: "purchased",
            thankedAt: at(3),
            createdAt: at(1),
            updatedAt: at(3),
          })
          .run();

        const cells = lines(yield* giftExportService.giftsCsv(BOOTSTRAP_WEDDING_ID))[1]!.split(",");
        expect(cells[12]).toBe("2026-08-20T10:03:00.000Z");
        expect(cells[13]).toBe("2026-08-20T10:01:00.000Z");
      }),
    ),
  );

  it("keeps the newest rows across both tables at the ceiling and warns that it cut", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    seedHousehold(db);
    seedOverflow(db, MAX_GIFT_EXPORT_ROWS + 1);

    const warnings: Array<{ message: string; annotations: Record<string, unknown> }> = [];
    // v4 log levels are capitalised string literals ("Warn"), `Logger.layer`
    // replaces the set of loggers rather than adding one, and a logger reads
    // annotations off the fiber rather than from its arguments.
    const capture = Logger.layer([
      Logger.make(({ logLevel, message, fiber }) => {
        if (logLevel === "Warn") {
          warnings.push({
            message: Array.isArray(message) ? message.join(" ") : String(message),
            annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
          });
        }
      }),
    ]);
    const csv = await Effect.runPromise(
      giftExportService
        .giftsCsv(BOOTSTRAP_WEDDING_ID)
        .pipe(Effect.provideService(DbService, db), Effect.provide(capture)),
    );

    const data = lines(csv).slice(1);
    expect(data).toHaveLength(MAX_GIFT_EXPORT_ROWS);
    // Newest first, the oldest one dropped: row-2000 (a cash gift) down to
    // row-1 (a claim), with row-0 nowhere. Truncation is tolerable only
    // because it loses the oldest end, so the order is pinned row by row.
    const notes = data.map((line) => line.split(",")[6]);
    expect(notes).toEqual(
      Array.from({ length: MAX_GIFT_EXPORT_ROWS }, (_, i) => `row-${MAX_GIFT_EXPORT_ROWS - i}`),
    );
    expect(data[0]!.startsWith("Cash gift,")).toBe(true);
    expect(data.at(-1)!.startsWith("Gift list,")).toBe(true);
    expect(csv).not.toContain(",row-0,");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("exceeds the export ceiling");
    // The read stops one row past the ceiling, so any row count it could log
    // would only ever be that. It says what happened instead.
    expect(warnings[0]!.annotations).toEqual({
      weddingId: BOOTSTRAP_WEDDING_ID,
      exportCap: MAX_GIFT_EXPORT_ROWS,
      truncated: true,
    });
  }, 30_000);

  it("prints a log exactly at the ceiling whole, and does not warn", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    seedHousehold(db);
    seedOverflow(db, MAX_GIFT_EXPORT_ROWS);

    const warnings: string[] = [];
    const capture = Logger.layer([
      Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(String(message));
      }),
    ]);
    const csv = await Effect.runPromise(
      giftExportService
        .giftsCsv(BOOTSTRAP_WEDDING_ID)
        .pipe(Effect.provideService(DbService, db), Effect.provide(capture)),
    );

    // The other side of the boundary: a file that was not cut keeps its oldest
    // row and raises no alarm.
    const notes = lines(csv)
      .slice(1)
      .map((line) => line.split(",")[6]);
    expect(notes).toEqual(
      Array.from({ length: MAX_GIFT_EXPORT_ROWS }, (_, i) => `row-${MAX_GIFT_EXPORT_ROWS - 1 - i}`),
    );
    expect(warnings).toEqual([]);
  }, 30_000);

  it("reads the whole log in one statement that stops one row past the ceiling", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    seedHousehold(db);
    seedOverflow(db, 2 * (MAX_GIFT_EXPORT_ROWS + 1));

    const statements = recordStatements(db);
    await Effect.runPromise(
      giftExportService
        .giftsCsv(BOOTSTRAP_WEDDING_ID)
        .pipe(Effect.provideService(DbService, db), Effect.provide(silent)),
    );

    // Each table alone holds more rows than the ceiling (2,001 of each), so
    // reading each to the ceiling separately would fetch 4,002 rows to print
    // 2,000. One statement, cut once, fetches the ceiling plus the single row
    // that tells the export it was cut.
    expect(statements).toHaveLength(1);
    expect(statements[0]!.rowCounts).toEqual([MAX_GIFT_EXPORT_ROWS + 1]);
  }, 30_000);

  it("prints exactly the rows the portal's gift log shows", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    seedParity(db);
    const provide = <A>(eff: Effect.Effect<A, never, DbService>) =>
      Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));

    const portal: GiftLogEntryDto[] = [];
    for (let offset = 0; ;) {
      const page = await provide(registryService.giftLog(BOOTSTRAP_WEDDING_ID, { offset }));
      portal.push(...page.entries);
      if (!page.hasMore) break;
      offset += page.entries.length;
    }
    const exported = lines(await provide(giftExportService.giftsCsv(BOOTSTRAP_WEDDING_ID))).slice(
      1,
    );

    // Every printed column, not a key: the union matches its two branches by
    // position, so a column read from the wrong field would still produce
    // the right number of rows. Sorted arrays rather than sets, so a row a
    // join doubled cannot hide.
    const portalRows = portal.map(asExportLine).toSorted();
    expect(exported.toSorted()).toEqual(portalRows);
    // The seed: 3 claims and 8 cash gifts on this wedding, one of them
    // failed, plus two gifts on another wedding that neither side may show.
    expect(portalRows).toHaveLength(10);
    expect(exported.join("\n")).not.toContain("Someone Else");
  }, 30_000);
});
