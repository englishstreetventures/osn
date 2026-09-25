import { families, registryClaims, registryContributions, registryItems } from "@cire/db";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { serialiseCsv } from "../lib/csv";
import { minorToDecimal } from "../lib/money";
import { giftNoteView } from "./registry";

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
 * killed with `exceededCpu`.
 *
 * Streaming the response would not raise it. Workers counts the CPU spent
 * running the Worker's code, and serialising rows into a stream is still that
 * code, so a streamed file costs the same CPU as a buffered one. Memory does
 * not bind either: a 2,000-row file is far inside the 128 MB an isolate may
 * use. Raising the ceiling means cutting what `serialiseCsv` spends per row.
 */
export const MAX_GIFT_EXPORT_ROWS = 2000;

type GiftKind = "Gift list" | "Cash gift";

const iso = (at: Date | null): string => (at ? at.toISOString() : "");

/**
 * The Note cell. A note a host hid prints as `Note hidden`, never its words —
 * the same rule, through the same function, as the portal's gift log.
 */
const noteCell = (note: string | null, hiddenAt: Date | null): string => {
  const view = giftNoteView(note, hiddenAt);
  return view.noteHidden ? "Note hidden" : (view.note ?? "");
};

/**
 * The couple's gift log as a CSV download — the third organiser export, and the
 * one that answers a data-portability request. The portal shows this log
 * a page at a time and keeps it for a year; the export is how the couple take
 * the detail with them before the retention sweep folds it into totals.
 *
 * Reads the same two tables as `registryService.giftLog` with the same joins
 * and filters, deliberately: the same `failed`-contributions exclusion (money
 * that never moved is not a gift, while a `refunded` gift did happen and stays
 * visible), the same LEFT join for cash gifts that have no item, and NO
 * host-family exclusion, because the export must contain exactly what the
 * portal shows and nothing else. A parity test in
 * `tests/services/gift-export.test.ts` holds the two to that.
 *
 * A note a host hid from the gift log is hidden here too: the Note cell reads
 * `Note hidden`. The words stay in the database for the guest's own view and a
 * data-subject request, not in the couple's file.
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

      // Both tables in one statement: SQLite merges the two branches newest
      // first and stops at `readAhead`, so the Worker never receives a row it
      // will not print. Each branch walks its own `(wedding_id, created_at)`
      // index in order, which is what lets the merge stop early.
      //
      // The branches are matched by POSITION, so both list the same columns in
      // the same order, with a NULL literal where a column belongs to the other
      // table. Every literal carries an alias so no two result columns share a
      // name: the D1 driver's batch path keys a row by column name.
      // The claims branch's `itemTitle`, `quantity` and `status` are widened to
      // the cash-gift types, because Drizzle types the whole union from its
      // first branch.
      const claims = db
        .select({
          kind: sql<GiftKind>`'Gift list'`.as("kind"),
          itemTitle: sql<string | null>`${registryItems.title}`,
          familyName: families.familyName,
          displayName: registryClaims.displayName,
          quantity: sql<number | null>`${registryClaims.quantity}`,
          status: sql<string>`${registryClaims.status}`,
          note: registryClaims.note,
          noteHiddenAt: registryClaims.noteHiddenAt,
          amountMinor: sql<number | null>`NULL`.as("amount_minor"),
          currency: sql<string | null>`NULL`.as("currency"),
          primaryAmountMinor: sql<number | null>`NULL`.as("primary_amount_minor"),
          primaryCurrency: sql<string | null>`NULL`.as("primary_currency"),
          fxRate: sql<string | null>`NULL`.as("fx_rate"),
          thankedAt: registryClaims.thankedAt,
          // Aliased because a compound SELECT can only ORDER BY a name its
          // first branch declares with AS.
          createdAt: sql<Date>`${registryClaims.createdAt}`
            .mapWith(registryClaims.createdAt)
            .as("created_at"),
        })
        .from(registryClaims)
        .innerJoin(registryItems, eq(registryClaims.itemId, registryItems.id))
        .innerJoin(families, eq(registryClaims.familyId, families.id))
        .where(eq(registryClaims.weddingId, weddingId));

      const cashGifts = db
        .select({
          kind: sql<GiftKind>`'Cash gift'`.as("kind"),
          itemTitle: registryItems.title,
          familyName: families.familyName,
          displayName: registryContributions.displayName,
          quantity: sql<number | null>`NULL`.as("quantity"),
          status: registryContributions.status,
          note: registryContributions.message,
          noteHiddenAt: registryContributions.noteHiddenAt,
          amountMinor: registryContributions.amountMinor,
          currency: registryContributions.currency,
          primaryAmountMinor: registryContributions.primaryAmountMinor,
          primaryCurrency: registryContributions.primaryCurrency,
          fxRate: registryContributions.fxRate,
          thankedAt: registryContributions.thankedAt,
          createdAt: sql<Date>`${registryContributions.createdAt}`
            .mapWith(registryContributions.createdAt)
            .as("created_at"),
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
        );

      // Newest first, the order the portal's log is read in.
      const gifts = yield* dbQuery(() =>
        unionAll(claims, cashGifts)
          .orderBy(desc(sql`created_at`))
          .limit(readAhead)
          .all(),
      );

      if (gifts.length > MAX_GIFT_EXPORT_ROWS) {
        // No row count: the read stops one past the ceiling, so it could only
        // ever report that. The warning says the file was cut, and at what.
        yield* Effect.logWarning("[gift-export] gift log exceeds the export ceiling").pipe(
          Effect.annotateLogs({
            weddingId,
            exportCap: MAX_GIFT_EXPORT_ROWS,
            truncated: true,
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
      const rows = gifts
        .slice(0, MAX_GIFT_EXPORT_ROWS)
        .map((g) => [
          g.kind,
          g.itemTitle ?? "",
          g.familyName,
          g.displayName ?? "",
          g.quantity === null ? "" : String(g.quantity),
          g.status,
          noteCell(g.note, g.noteHiddenAt),
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
