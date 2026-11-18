import { VENDOR_STATUSES, vendors, weddings } from "@cire/db";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { serialiseCsv } from "../lib/csv";
import { displayRank } from "../lib/display-rank";
import { minorToDecimal } from "../lib/money";
import { SERVICE_CATEGORIES } from "../lib/service-categories";

/**
 * Row ceiling on `vendors.csv`. Nothing caps how many vendors a wedding lists,
 * so the file is bounded the way the planning files are
 * (`MAX_PLANNING_EXPORT_ROWS` in `planning-export.ts`, whose comment carries the
 * CPU measurement): one row past it in the database, and a cut logged.
 */
export const MAX_VENDOR_EXPORT_ROWS = 1000;

const HEADER = [
  "Vendor",
  "Category",
  "Stage",
  "Contact",
  "Email",
  "Phone",
  "Quoted",
  "Currency",
  "Notes",
  "Added",
];

const categoryLabel = new Map<string, string>(SERVICE_CATEGORIES.map((c) => [c.key, c.label]));
const stageLabel = (status: string): string => status.charAt(0).toUpperCase() + status.slice(1);

/**
 * The couple's vendor list for the whole-wedding archive
 * (`services/wedding-archive.ts`), in the Vendors page's order: by stage, then
 * the couple's order within it. The conversations with a listed vendor are
 * messages held by Zap, not rows here, and are not in the file.
 */
export const vendorExportService = {
  vendorsCsv(weddingId: string): Effect.Effect<string, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({
            name: vendors.name,
            category: vendors.category,
            status: vendors.status,
            contactName: vendors.contactName,
            email: vendors.email,
            phone: vendors.phone,
            quotedMinor: vendors.quotedMinor,
            notes: vendors.notes,
            createdAt: vendors.createdAt,
            currency: weddings.currency,
          })
          .from(vendors)
          .innerJoin(weddings, eq(weddings.id, vendors.weddingId))
          .where(eq(vendors.weddingId, weddingId))
          .orderBy(
            displayRank(vendors.status, VENDOR_STATUSES),
            asc(vendors.sortOrder),
            asc(vendors.createdAt),
            asc(vendors.id),
          )
          .limit(MAX_VENDOR_EXPORT_ROWS + 1)
          .all(),
      );
      if (rows.length > MAX_VENDOR_EXPORT_ROWS) {
        yield* Effect.logWarning("vendors.csv exceeds the export ceiling; cut").pipe(
          Effect.annotateLogs({ weddingId, exportCap: MAX_VENDOR_EXPORT_ROWS }),
        );
      }
      return serialiseCsv(
        HEADER,
        rows
          .slice(0, MAX_VENDOR_EXPORT_ROWS)
          .map((row) => [
            row.name,
            categoryLabel.get(row.category) ?? row.category,
            stageLabel(row.status),
            row.contactName ?? "",
            row.email ?? "",
            row.phone ?? "",
            row.quotedMinor === null ? "" : minorToDecimal(row.quotedMinor, row.currency),
            row.currency,
            row.notes ?? "",
            row.createdAt.toISOString(),
          ]),
      );
    }).pipe(Effect.withSpan("cire.vendor-export.vendorsCsv"));
  },
};
