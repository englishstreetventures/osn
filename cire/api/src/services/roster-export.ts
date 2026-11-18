import { families, guests } from "@cire/db";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery, outerColumn } from "../db";
import { serialiseCsv } from "../lib/csv";

/**
 * Row ceiling on `households.csv`. A wedding holds at most 1,000 guests by
 * plan, and a household can hold none, so the ceiling sits at twice that; it
 * bounds the read the way every export's ceiling does, one row past it in the
 * database (`wiki/cire/cire-development.md` §CSV exports).
 */
export const MAX_HOUSEHOLD_EXPORT_ROWS = 2000;

const HEADER = [
  "Family Code",
  "Family Name",
  "Guests",
  "Code Sent",
  "First Opened",
  "Code Status",
  "Added",
];

const iso = (at: Date | null): string => (at === null ? "" : at.toISOString());

/**
 * The wedding's households for the whole-wedding archive
 * (`services/wedding-archive.ts`): one row per household, including those
 * holding no guest, which `guests.csv` cannot show. The host-preview household
 * is not one of the couple's and is left out, as every roster read does. The
 * code is the guests' credential; the archive goes only to an owner, as
 * `guests.csv` does.
 */
export const rosterExportService = {
  householdsCsv(weddingId: string): Effect.Effect<string, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({
            publicId: families.publicId,
            familyName: families.familyName,
            guestCount: sql<number>`(SELECT count(*) FROM ${guests} WHERE ${guests.familyId} = ${outerColumn(families.id)})`,
            codeSharedAt: families.codeSharedAt,
            firstOpenedAt: families.firstOpenedAt,
            deactivatedAt: families.deactivatedAt,
            createdAt: families.createdAt,
          })
          .from(families)
          .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
          .orderBy(asc(families.publicId))
          .limit(MAX_HOUSEHOLD_EXPORT_ROWS + 1)
          .all(),
      );
      if (rows.length > MAX_HOUSEHOLD_EXPORT_ROWS) {
        yield* Effect.logWarning("households.csv exceeds the export ceiling; cut").pipe(
          Effect.annotateLogs({ weddingId, exportCap: MAX_HOUSEHOLD_EXPORT_ROWS }),
        );
      }
      return serialiseCsv(
        HEADER,
        rows
          .slice(0, MAX_HOUSEHOLD_EXPORT_ROWS)
          .map((row) => [
            row.publicId,
            row.familyName,
            String(row.guestCount),
            iso(row.codeSharedAt),
            iso(row.firstOpenedAt),
            row.deactivatedAt === null ? "Active" : "Deactivated",
            iso(row.createdAt),
          ]),
      );
    }).pipe(Effect.withSpan("cire.roster-export.householdsCsv"));
  },
};
