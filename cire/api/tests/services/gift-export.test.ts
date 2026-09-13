import { describe, it, expect } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  families,
  registryClaims,
  registryContributions,
  registryItems,
} from "@cire/db";
import { Effect, Logger } from "effect";

import type { Db } from "../../src/db";
import { DbService } from "../../src/db";
import { MAX_GIFT_EXPORT_ROWS, giftExportService } from "../../src/services/gift-export";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";

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

  it(
    "caps the export at the ceiling and warns rather than truncating in silence",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        seedHousehold(db);
        const overflow = MAX_GIFT_EXPORT_ROWS + 1;
        // One statement per chunk keeps every insert under SQLite's 999
        // bound-variable ceiling.
        const chunk = 100;
        for (let start = 0; start < overflow; start += chunk) {
          const values = Array.from({ length: Math.min(chunk, overflow - start) }, (_, i) => ({
            id: `rcon_bulk_${start + i}`,
            weddingId: BOOTSTRAP_WEDDING_ID,
            familyId: "fam_gifts",
            status: "succeeded" as const,
            amountMinor: 100,
            currency: "AUD",
            createdAt: at(1),
            updatedAt: at(1),
          }));
          db.insert(registryContributions).values(values).run();
        }

        const warnings: string[] = [];
        // v4 log levels are capitalised string literals ("Warn"), and
        // `Logger.layer` replaces the set of loggers rather than one of them.
        const capture = Logger.layer([
          Logger.make(({ logLevel, message }) => {
            if (logLevel === "Warn") {
              warnings.push(Array.isArray(message) ? message.join(" ") : String(message));
            }
          }),
        ]);
        const csv = yield* giftExportService
          .giftsCsv(BOOTSTRAP_WEDDING_ID)
          .pipe(Effect.provide(capture));

        expect(lines(csv)).toHaveLength(MAX_GIFT_EXPORT_ROWS + 1);
        expect(warnings.join(" ")).toContain("exceeds the export ceiling");
      }),
    ),
  );
});
