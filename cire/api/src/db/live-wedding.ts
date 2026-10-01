/**
 * The one spelling of "this wedding is live" — not soft-deleted.
 *
 * A soft-deleted wedding (`weddings.deleted_at` set) must be unreachable from
 * every guest, vendor and co-host path, and from every organiser route except
 * its owners' restore. Every query that starts from a slug, a claim code, a
 * guest session, a wedding id or a row that belongs to a wedding, and that does
 * not go through `hostsService.authorize()`, carries one of these predicates in
 * the statement it already runs.
 */
import { weddings } from "@cire/db";
import { isNull, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";

import { outerColumn } from "./index";

/**
 * How long an owner can restore a deleted wedding, in SECONDS — the unit of
 * `weddings.deleted_at` (`mode: "timestamp"`), which every SQL comparison uses.
 * Past it the restore route refuses and the daily purge may hard-delete.
 */
export const RESTORE_WINDOW_S = 7 * 24 * 60 * 60;

/** For a query that already reads `weddings`. */
export const weddingIsLive: SQL = isNull(weddings.deletedAt);

/**
 * For a query that holds only a wedding id (`vendor_enquiries.wedding_id` and
 * the like). A correlated `EXISTS`, so the outer column renders qualified
 * through {@link outerColumn}: bare, it would bind to the subquery's own `id`.
 */
export const weddingIdIsLive = (column: AnyColumn): SQL =>
  sql`EXISTS (SELECT 1 FROM ${weddings} WHERE ${weddings.id} = ${outerColumn(column)} AND ${weddings.deletedAt} IS NULL)`;

/** Epoch seconds, the unit `deleted_at` and the `created_at` columns hold. */
export const epochSeconds = (at: Date): number => Math.floor(at.getTime() / 1000);

/** When a wedding deleted at `deletedAt` stops being restorable. */
export const restoreUntil = (deletedAt: Date): Date =>
  new Date(deletedAt.getTime() + RESTORE_WINDOW_S * 1000);
