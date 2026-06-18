/**
 * Organiser-triggered bulk re-mint of a wedding's family claim codes onto a new
 * style (C3).
 *
 * Distinct from the one-time legacy→new-format operator script
 * (`scripts/remint-family-codes.ts`, which only touches *legacy*-format codes
 * and keeps the wedding's current style) and from the per-family
 * `regenerateCodeService` (rotates ONE family on the current style). This
 * service:
 *  1. switches `weddings.code_style` to the chosen style, and
 *  2. for EVERY guest family under the wedding, mints a fresh code on the new
 *     style, clears `code_shared_at` (the old shared code is now dead), and
 *     revokes all of that family's guest sessions
 * — all in **one atomic D1 batch**. The atomicity is the security property: the
 * style flip, the rotated codes, and the session revocations all land in the
 * same commit, so no guest can authenticate with a stale code mid-remint.
 *
 * The synthetic `HOST-*` preview family is deliberately left untouched — its
 * code is not a guest claim code and is managed by the preview-code endpoint.
 *
 * Tenant safety is enforced one layer up by `weddingOwner()` (the caller owns
 * `weddingId`); this service only ever reads/writes rows scoped to `weddingId`.
 */

import { families, sessions, weddings as weddingsTable } from "@cire/db";
import { and, eq, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Data, Effect } from "effect";

import { commitBatch, DbService, dbQuery } from "../db";
import { metricWeddingReminted } from "../metrics";
import { generateFamilyCode } from "./family-code";
import type { CodeStyle } from "./family-code";

export class WeddingNotFound extends Data.TaggedError("WeddingNotFound") {}

export class RemintWriteError extends Data.TaggedError("RemintWriteError")<{
  reason: string;
}> {}

export interface RemintResult {
  /** The style every guest family now sits on. */
  codeStyle: CodeStyle;
  /** How many guest families had their code rotated. */
  reminted: number;
}

export const remintCodesService = {
  /**
   * Flip `weddingId` onto `codeStyle` and rotate every guest family's code onto
   * it, clearing each family's `code_shared_at` and revoking its sessions —
   * atomically. Fails `WeddingNotFound` when the wedding doesn't exist.
   */
  remint(
    weddingId: string,
    codeStyle: CodeStyle,
  ): Effect.Effect<RemintResult, WeddingNotFound | RemintWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const [wedding] = yield* dbQuery(() =>
        db
          .select({ id: weddingsTable.id })
          .from(weddingsTable)
          .where(eq(weddingsTable.id, weddingId))
          .all(),
      );
      if (!wedding) {
        return yield* Effect.fail(new WeddingNotFound());
      }

      // Every GUEST family in the wedding (host preview family excluded).
      const guestFamilies = yield* dbQuery(() =>
        db
          .select({ id: families.id, familyName: families.familyName })
          .from(families)
          .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
          .all(),
      );

      // Mint fresh codes up front, de-duped against codes already taken in this
      // wedding + ones minted earlier in this run, so a freshly-drawn code can't
      // collide on the unique index and abort the whole batch.
      const used = new Set<string>();
      const existing = yield* dbQuery(() =>
        db
          .select({ publicId: families.publicId })
          .from(families)
          .where(eq(families.weddingId, weddingId))
          .all(),
      );
      for (const r of existing) used.add(r.publicId);

      const statements: BatchItem<"sqlite">[] = [
        // Flip the wedding's style first so future per-family regenerations land
        // on the new tier too.
        db
          .update(weddingsTable)
          .set({ codeStyle, updatedAt: new Date() })
          .where(eq(weddingsTable.id, weddingId)),
      ];
      const now = new Date();
      for (const fam of guestFamilies) {
        let code = generateFamilyCode(fam.familyName, codeStyle);
        while (used.has(code)) code = generateFamilyCode(fam.familyName, codeStyle);
        used.add(code);
        statements.push(
          // Rotate the code + clear the "shared" marker in one update.
          db
            .update(families)
            .set({ publicId: code, codeSharedAt: null, updatedAt: now })
            .where(eq(families.id, fam.id)),
          // Revoke every live session minted from the old code.
          db.delete(sessions).where(eq(sessions.familyId, fam.id)),
        );
      }

      yield* Effect.tryPromise({
        try: () => commitBatch(db, statements),
        catch: (cause) => new RemintWriteError({ reason: String(cause) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("wedding-code remint failed", { reason: err.reason }),
        ),
      );

      yield* Effect.logInfo("wedding-code remint complete", {
        weddingId,
        codeStyle,
        reminted: guestFamilies.length,
      });

      return { codeStyle, reminted: guestFamilies.length };
    }).pipe(
      Effect.tap((r) => Effect.sync(() => metricWeddingReminted("ok", r.codeStyle))),
      Effect.tapError((e) =>
        e._tag === "RemintWriteError"
          ? Effect.sync(() => metricWeddingReminted("error", codeStyle))
          : Effect.void,
      ),
      Effect.withSpan("cire.wedding.remint"),
    );
  },
};
