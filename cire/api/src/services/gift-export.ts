import { families, registryClaims, registryContributions, registryItems } from "@cire/db";
import { and, desc, eq, ne } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { serialiseCsv } from "../lib/csv";
import { minorToDecimal } from "../lib/money";

/**
 * Row ceiling on one gift export.
 *
 * The gift log is unbounded in principle — every household may claim every item
 * and send cash on top — and the portal answers that with paging
 * (`registryService.giftLog`). An export cannot page: the whole point of the
 * download is that it is the whole record. So it is bounded instead, and a read
 * that hits the ceiling is LOGGED rather than silently truncated — a
 * portability answer that quietly drops rows is worse than no answer at all.
 *
 * The number comes from the CPU budget, NOT from how many gifts a wedding
 * plausibly has. Cloudflare Workers Free allows 10 ms of CPU per
 * invocation (`wiki/shared/free-tier-limits.md`), and building this file is
 * dominated by `serialiseCsv`, which trims, scans and quotes every one of the
 * fourteen cells in a row: measured at roughly 6 ms for 2,000 rows and 11 ms
 * for 5,000, so the higher figure spends the whole budget and the request is
 * killed with `exceededCpu`. Raising it back to "a plausible wedding" means
 * streaming the response first — see the follow-up issue on this file.
 */
export const MAX_GIFT_EXPORT_ROWS = 2000;

/** One gift, already flattened into the columns the CSV prints. */
interface GiftRow {
  kind: "Gift list" | "Cash gift";
  itemTitle: string | null;
  familyName: string;
  displayName: string | null;
  quantity: number | null;
  status: string;
  note: string | null;
  amountMinor: number | null;
  currency: string | null;
  primaryAmountMinor: number | null;
  primaryCurrency: string | null;
  fxRate: string | null;
  thankedAt: Date | null;
  createdAt: Date;
}

const iso = (at: Date | null): string => (at ? at.toISOString() : "");

/**
 * The couple's gift log as a CSV download — the third organiser export, and the
 * one that answers a data-portability request. The portal shows this log
 * a page at a time and keeps it for a year; the export is how the couple take
 * the detail with them before the retention sweep folds it into totals.
 *
 * Reads the same two tables as `registryService.giftLog`, with the same shape
 * deliberately: the same `failed`-contributions exclusion (money that never
 * moved is not a gift, while a `refunded` gift did happen and stays
 * visible), the same LEFT join for cash gifts that have no item, and NO
 * host-family exclusion, because the export must contain exactly what the
 * portal shows and nothing else.
 *
 * A household is named, never coded. `families.public_id` is the claim
 * code — a bearer credential that opens that household's invite on its own —
 * and the portal's gift log does not return it, so neither does the file. The
 * household name plus the giver's chosen display name is what a thank-you list
 * needs, and it leaves nothing on a laptop or in a mail attachment that could
 * be used to sign in as a guest.
 *
 * Amounts are printed as bare major-unit decimals with the currency in its own
 * column — a spreadsheet can sum a number, not "$12.50" — and the primary
 * -currency columns carry the equivalent snapshotted at charge time, blank for a
 * gift that already arrived in the wedding's own currency.
 */
export const giftExportService = {
  giftsCsv(weddingId: string): Effect.Effect<string, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // One over the ceiling, so the truncation warning below fires on the row
      // that would have been dropped rather than on the last one kept.
      const readAhead = MAX_GIFT_EXPORT_ROWS + 1;

      // The two reads are independently wedding-scoped — collapse them to one
      // D1 round-trip; matches the parallel shape in table-export.ts.
      const [claimRows, contributionRows] = yield* Effect.all(
        [
          dbQuery(() =>
            db
              .select({
                id: registryClaims.id,
                itemTitle: registryItems.title,
                familyName: families.familyName,
                displayName: registryClaims.displayName,
                quantity: registryClaims.quantity,
                status: registryClaims.status,
                note: registryClaims.note,
                thankedAt: registryClaims.thankedAt,
                createdAt: registryClaims.createdAt,
              })
              .from(registryClaims)
              .innerJoin(registryItems, eq(registryClaims.itemId, registryItems.id))
              .innerJoin(families, eq(registryClaims.familyId, families.id))
              .where(eq(registryClaims.weddingId, weddingId))
              .orderBy(desc(registryClaims.createdAt))
              .limit(readAhead)
              .all(),
          ),
          dbQuery(() =>
            db
              .select({
                id: registryContributions.id,
                itemTitle: registryItems.title,
                familyName: families.familyName,
                displayName: registryContributions.displayName,
                status: registryContributions.status,
                note: registryContributions.message,
                amountMinor: registryContributions.amountMinor,
                currency: registryContributions.currency,
                primaryAmountMinor: registryContributions.primaryAmountMinor,
                primaryCurrency: registryContributions.primaryCurrency,
                fxRate: registryContributions.fxRate,
                thankedAt: registryContributions.thankedAt,
                createdAt: registryContributions.createdAt,
              })
              .from(registryContributions)
              // LEFT: a general cash gift has no item, and an item deleted after
              // the fact sets `item_id` NULL rather than erasing the gift.
              .leftJoin(registryItems, eq(registryContributions.itemId, registryItems.id))
              .innerJoin(families, eq(registryContributions.familyId, families.id))
              .where(
                and(
                  eq(registryContributions.weddingId, weddingId),
                  ne(registryContributions.status, "failed"),
                ),
              )
              .orderBy(desc(registryContributions.createdAt))
              .limit(readAhead)
              .all(),
          ),
        ],
        { concurrency: 2 },
      );

      const claims: GiftRow[] = (
        claimRows as Array<{
          itemTitle: string;
          familyName: string;
          displayName: string | null;
          quantity: number;
          status: string;
          note: string | null;
          thankedAt: Date | null;
          createdAt: Date;
        }>
      ).map((r) => ({
        kind: "Gift list" as const,
        itemTitle: r.itemTitle,
        familyName: r.familyName,
        displayName: r.displayName,
        quantity: r.quantity,
        status: r.status,
        note: r.note,
        amountMinor: null,
        currency: null,
        primaryAmountMinor: null,
        primaryCurrency: null,
        fxRate: null,
        thankedAt: r.thankedAt,
        createdAt: r.createdAt,
      }));

      const contributions: GiftRow[] = (
        contributionRows as Array<{
          itemTitle: string | null;
          familyName: string;
          displayName: string | null;
          status: string;
          note: string | null;
          amountMinor: number;
          currency: string;
          primaryAmountMinor: number | null;
          primaryCurrency: string | null;
          fxRate: string | null;
          thankedAt: Date | null;
          createdAt: Date;
        }>
      ).map((r) => ({
        kind: "Cash gift" as const,
        itemTitle: r.itemTitle,
        familyName: r.familyName,
        displayName: r.displayName,
        quantity: null,
        status: r.status,
        note: r.note,
        amountMinor: r.amountMinor,
        currency: r.currency,
        primaryAmountMinor: r.primaryAmountMinor,
        primaryCurrency: r.primaryCurrency,
        fxRate: r.fxRate,
        thankedAt: r.thankedAt,
        createdAt: r.createdAt,
      }));

      // Newest first, the order the portal's log is read in. Sorted in place:
      // `merged` is built here and handed to nobody else, so this is not the
      // shared-array aliasing hazard oxlint's `no-array-sort` guards against.
      const merged: GiftRow[] = [...claims, ...contributions];
      merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      if (merged.length > MAX_GIFT_EXPORT_ROWS) {
        yield* Effect.logWarning("[gift-export] gift log exceeds the export ceiling").pipe(
          Effect.annotateLogs({
            weddingId,
            rows: merged.length,
            exportCap: MAX_GIFT_EXPORT_ROWS,
          }),
        );
      }

      const header = [
        "Kind",
        "Item",
        "Household",
        "Given As",
        "Quantity",
        "Status",
        "Note",
        "Amount",
        "Currency",
        "Amount In Your Currency",
        "Your Currency",
        "Exchange Rate",
        "Thanked At",
        "Received At",
      ];
      const rows = merged
        .slice(0, MAX_GIFT_EXPORT_ROWS)
        .map((g) => [
          g.kind,
          g.itemTitle ?? "",
          g.familyName,
          g.displayName ?? "",
          g.quantity === null ? "" : String(g.quantity),
          g.status,
          g.note ?? "",
          g.amountMinor === null || g.currency === null
            ? ""
            : minorToDecimal(g.amountMinor, g.currency),
          g.currency ?? "",
          g.primaryAmountMinor === null || g.primaryCurrency === null
            ? ""
            : minorToDecimal(g.primaryAmountMinor, g.primaryCurrency),
          g.primaryCurrency ?? "",
          g.fxRate ?? "",
          iso(g.thankedAt),
          iso(g.createdAt),
        ]);

      return serialiseCsv(header, rows);
    }).pipe(Effect.withSpan("cire.gift-export.giftsCsv"));
  },
};
