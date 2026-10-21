import { emailSuppressions } from "@cire/db";
import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect } from "effect";

import { type Db, DbService, dbQuery } from "../db";

// The suppression list: addresses a wedding must not email
// (`email_suppressions`, [[wiki/compliance/data-map]]).
//
// A row holds a hash, never an address, and names the seat that withdrew the
// address. An address is suppressed for the wedding when any row matches its
// hash, so one seat's objection stops mail to every seat holding it; only the
// seat that made a row clears it, by giving the address again. Guest comms
// read {@link suppressedHashes} before sending.

/**
 * The SHA-256, in lower-case hex, of `weddingId + ":" + address`, where
 * `address` is the stored (normalised) form. Keyed by the wedding so one
 * person's rows in two weddings do not share a value. Not a secret: it keeps
 * the plain address out of the table, and it is still pseudonymous personal
 * data — a DSAR finds a guest's rows by hashing their address the same way.
 */
export async function hashGuestEmail(weddingId: string, address: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${weddingId}:${address}`),
  );
  // Built from the bytes: Workers' `Buffer` type has no hex `toString`.
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Record that `guestId` withdrew the address hashing to `emailHash`. A second
 *  identical opt-out is a no-op. */
export function suppressStatement(
  db: Db,
  row: { weddingId: string; emailHash: string; guestId: string; now: Date },
): BatchItem<"sqlite"> {
  return db
    .insert(emailSuppressions)
    .values({
      id: crypto.randomUUID(),
      weddingId: row.weddingId,
      emailHash: row.emailHash,
      guestId: row.guestId,
      reason: "guest_removed",
      createdAt: row.now,
    })
    .onConflictDoNothing();
}

/** Clear the opt-out `guestId` itself made for this address, and no other. */
export function unsuppressOwnStatement(
  db: Db,
  row: { weddingId: string; emailHash: string; guestId: string },
): BatchItem<"sqlite"> {
  return db
    .delete(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.weddingId, row.weddingId),
        eq(emailSuppressions.emailHash, row.emailHash),
        eq(emailSuppressions.guestId, row.guestId),
      ),
    );
}

/** Every suppressed address hash of a wedding. One read. */
export function suppressedHashes(weddingId: string): Effect.Effect<Set<string>, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .selectDistinct({ hash: emailSuppressions.emailHash })
        .from(emailSuppressions)
        .where(eq(emailSuppressions.weddingId, weddingId))
        .all(),
    );
    return new Set(rows.map((r) => r.hash));
  }).pipe(Effect.withSpan("cire.suppression.read"));
}
