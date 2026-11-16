import { registryItems, weddings } from "@cire/db";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { serialiseCsv } from "../lib/csv";
import { minorToDecimal } from "../lib/money";

/**
 * Row ceiling on `registry.csv`. A wedding lists at most 500 gifts
 * (`MAX_ITEMS_PER_WEDDING` in `services/registry.ts`), so rows the portal wrote
 * never reach it; it bounds the read the way every export's ceiling does.
 */
export const MAX_REGISTRY_EXPORT_ROWS = 1000;

const HEADER = [
  "Gift",
  "Kind",
  "Category",
  "Description",
  "Price",
  "Wanted",
  "Group Gift",
  "Target",
  "Currency",
  "Link",
];

/** One gift's picture, in the list's order: its title and the R2 key of its image. */
export interface GiftPicture {
  readonly title: string;
  readonly imageKey: string | null;
}

/**
 * The couple's gift list for the whole-wedding archive
 * (`services/wedding-archive.ts`), in the list's own order: what they asked
 * for, not what guests gave (that is `gifts.csv`). Each gift's picture is in
 * the archive's `files/registry/` folder, under the same position.
 */
export const registryExportService = {
  /** `registry.csv` alone (`items` without the pictures). */
  itemsCsv(weddingId: string): Effect.Effect<string, never, DbService> {
    return registryExportService.items(weddingId).pipe(Effect.map((items) => items.csv));
  },

  /**
   * `registry.csv`, and each listed gift's picture in the same order, from one
   * read: the archive names a gift's picture by its position in the file.
   */
  items(
    weddingId: string,
  ): Effect.Effect<{ csv: string; pictures: ReadonlyArray<GiftPicture> }, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({
            title: registryItems.title,
            kind: registryItems.kind,
            category: registryItems.category,
            description: registryItems.description,
            priceMinor: registryItems.priceMinor,
            quantityWanted: registryItems.quantityWanted,
            allowPartial: registryItems.allowPartial,
            targetMinor: registryItems.targetMinor,
            externalUrl: registryItems.externalUrl,
            imageKey: registryItems.imageKey,
            currency: weddings.currency,
          })
          .from(registryItems)
          .innerJoin(weddings, eq(weddings.id, registryItems.weddingId))
          .where(eq(registryItems.weddingId, weddingId))
          .orderBy(asc(registryItems.sortOrder), asc(registryItems.id))
          .limit(MAX_REGISTRY_EXPORT_ROWS + 1)
          .all(),
      );
      if (rows.length > MAX_REGISTRY_EXPORT_ROWS) {
        yield* Effect.logWarning("registry.csv exceeds the export ceiling; cut").pipe(
          Effect.annotateLogs({ weddingId, exportCap: MAX_REGISTRY_EXPORT_ROWS }),
        );
      }
      const money = (minor: number | null, currency: string): string =>
        minor === null ? "" : minorToDecimal(minor, currency);
      const listed = rows.slice(0, MAX_REGISTRY_EXPORT_ROWS);
      const csv = serialiseCsv(
        HEADER,
        listed.map((row) => [
          row.title,
          row.kind === "cash_fund" ? "Fund" : "Gift",
          row.category ?? "",
          row.description ?? "",
          money(row.priceMinor, row.currency),
          String(row.quantityWanted),
          row.allowPartial ? "Yes" : "No",
          money(row.targetMinor, row.currency),
          row.currency,
          row.externalUrl ?? "",
        ]),
      );
      return {
        csv,
        pictures: listed.map((row) => ({ title: row.title, imageKey: row.imageKey })),
      };
    }).pipe(Effect.withSpan("cire.registry-export.items"));
  },
};
