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

/**
 * The couple's gift list for the whole-wedding archive
 * (`services/wedding-archive.ts`), in the list's own order: what they asked
 * for, not what guests gave (that is `gifts.csv`). Each gift's picture is in
 * the archive's `files/registry/` folder, under the same position.
 */
export const registryExportService = {
  itemsCsv(weddingId: string): Effect.Effect<string, never, DbService> {
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
      return serialiseCsv(
        HEADER,
        rows
          .slice(0, MAX_REGISTRY_EXPORT_ROWS)
          .map((row) => [
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
    }).pipe(Effect.withSpan("cire.registry-export.itemsCsv"));
  },
};
