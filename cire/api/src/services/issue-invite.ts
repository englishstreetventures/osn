/**
 * "Issue invite" — mint a claim code onto a CODE-LESS household (platform Phase 0
 * PR 4). This is the moment a manually-created guest-list record acquires an
 * invite credential.
 *
 * Two shapes:
 *  - `issueForFamily(weddingId, familyId)` — one code-less household.
 *  - `issueForAllCodeless(weddingId)` — bulk: every code-less GUEST household in
 *    the wedding, in one atomic D1 batch.
 *
 * Code generation is NOT reinvented — it reuses `generateFamilyCode`
 * (`SURNAME-WORD-HASH` via `services/family-code.ts`) on the wedding's
 * `code_style` tier, the same generator the CSV import + the re-mint machinery
 * use. Codes are de-duped up front against codes already taken in this wedding
 * (and ones minted earlier in the same bulk run) so a freshly-drawn code can't
 * collide on the partial unique index and abort the batch.
 *
 * Only households that are ACTUALLY code-less (`public_id IS NULL`) are touched:
 * issuing is idempotent-ish — a household that already has a code is skipped
 * (single) or excluded (bulk), never re-rotated (that's `regenerateCodeService`).
 * The synthetic host-preview family (`kind='host'`) is never in scope.
 *
 * Gated one layer up by `weddingOwner()` — minting a claim code is code
 * management (roles matrix, platform-plan §3.5), owner-only, same tier as
 * regenerate / remint / deactivate. This service re-checks family ∈ wedding, so
 * an owner of wedding A can't issue a code for a family under wedding B.
 */

import { families, weddings as weddingsTable } from "@cire/db";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Data, Effect } from "effect";

import { commitBatch, DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { metricInviteIssued } from "../metrics";
import { generateFamilyCode } from "./family-code";
import type { CodeStyle } from "./family-code";

/** The family isn't a code-less `kind='guest'` family under `weddingId`
 *  (missing, in another wedding, the host-preview family, or ALREADY has a
 *  code). 404-class for the single path. */
export class NotCodelessFamily extends Data.TaggedError("NotCodelessFamily") {}

export class IssueInviteWriteError extends Data.TaggedError("IssueInviteWriteError")<{
  reason: string;
}> {}

export interface IssuedInvite {
  familyId: string;
  publicId: string;
}

export interface BulkIssueResult {
  /** How many code-less households were issued a fresh code. */
  issued: number;
  /** The (familyId, publicId) pairs minted, for the caller to surface/refresh. */
  invites: IssuedInvite[];
}

/** Read the wedding's code tier — the style every newly-issued code lands on. */
function readCodeStyle(weddingId: string): Effect.Effect<CodeStyle | null, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [row] = yield* dbQuery(() =>
      db
        .select({ codeStyle: weddingsTable.codeStyle })
        .from(weddingsTable)
        .where(eq(weddingsTable.id, weddingId))
        .all(),
    );
    return row?.codeStyle ?? null;
  });
}

export const issueInviteService = {
  /**
   * Mint a code for ONE code-less household. Fails `NotCodelessFamily` if the
   * family isn't a code-less guest family under `weddingId` (so a household that
   * already has a code, the host-preview family, or a cross-tenant id all 404).
   */
  issueForFamily(
    weddingId: string,
    familyId: string,
  ): Effect.Effect<IssuedInvite, NotCodelessFamily | IssueInviteWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const style = yield* readCodeStyle(weddingId);
      if (!style) return yield* Effect.fail(new NotCodelessFamily());

      // Scope + kind + code-less check in one query: a row only comes back when
      // the family lives under this exact wedding, is a real guest family, AND
      // has no code yet.
      const [row] = yield* dbQuery(() =>
        db
          .select({ id: families.id, familyName: families.familyName })
          .from(families)
          .where(
            and(
              eq(families.id, familyId),
              eq(families.weddingId, weddingId),
              eq(families.kind, "guest"),
              isNull(families.publicId),
            ),
          )
          .all(),
      );
      if (!row) {
        return yield* Effect.fail(new NotCodelessFamily());
      }

      // De-dupe against every code already taken in this wedding.
      const used = yield* takenCodes(db, weddingId);
      let code = generateFamilyCode(row.familyName, style);
      while (used.has(code)) code = generateFamilyCode(row.familyName, style);

      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .update(families)
              .set({ publicId: code, updatedAt: new Date() })
              .where(eq(families.id, familyId))
              .run(),
          ),
        catch: (cause) => new IssueInviteWriteError({ reason: String(cause) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("issue-invite (single) failed", { reason: err.reason }),
        ),
      );

      return { familyId, publicId: code };
    }).pipe(
      Effect.tap(() => Effect.sync(() => metricInviteIssued("single", "ok"))),
      Effect.tapError((e) =>
        e._tag === "IssueInviteWriteError"
          ? Effect.sync(() => metricInviteIssued("single", "error"))
          : Effect.void,
      ),
      Effect.withSpan("cire.invite.issue.single"),
    );
  },

  /**
   * Bulk: mint a fresh code for EVERY code-less guest household in `weddingId`, in
   * one atomic batch. Households that already have a code are excluded (never
   * re-rotated). Returns `{ issued: 0, invites: [] }` when there's nothing to do.
   * Fails `IssueInviteWriteError` only on a write failure — a missing wedding
   * yields an empty result (the gate already proved the wedding exists).
   */
  issueForAllCodeless(
    weddingId: string,
  ): Effect.Effect<BulkIssueResult, IssueInviteWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const style = (yield* readCodeStyle(weddingId)) ?? "secure";

      // Every CODE-LESS guest family under the wedding (host-preview excluded).
      const codeless = yield* dbQuery(() =>
        db
          .select({ id: families.id, familyName: families.familyName })
          .from(families)
          .where(
            and(
              eq(families.weddingId, weddingId),
              ne(families.kind, "host"),
              isNull(families.publicId),
            ),
          )
          .all(),
      );
      if (codeless.length === 0) return { issued: 0, invites: [] };

      // Mint up front, de-duped against codes already taken in this wedding AND
      // ones minted earlier in this run, so nothing collides on the partial
      // unique index and aborts the whole batch.
      const used = yield* takenCodes(db, weddingId);
      const now = new Date();
      const invites: IssuedInvite[] = [];
      const statements: BatchItem<"sqlite">[] = [];
      for (const fam of codeless) {
        let code = generateFamilyCode(fam.familyName, style);
        while (used.has(code)) code = generateFamilyCode(fam.familyName, style);
        used.add(code);
        invites.push({ familyId: fam.id, publicId: code });
        statements.push(
          db
            .update(families)
            .set({ publicId: code, updatedAt: now })
            .where(eq(families.id, fam.id)),
        );
      }

      yield* Effect.tryPromise({
        try: () => commitBatch(db, statements),
        catch: (cause) => new IssueInviteWriteError({ reason: String(cause) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("issue-invite (bulk) failed", { reason: err.reason }),
        ),
      );

      yield* Effect.logInfo("issue-invite bulk complete", { weddingId, issued: invites.length });
      return { issued: invites.length, invites };
    }).pipe(
      Effect.tap((r) => Effect.sync(() => metricInviteIssued("bulk", "ok", r.issued))),
      Effect.tapError(() => Effect.sync(() => metricInviteIssued("bulk", "error"))),
      Effect.withSpan("cire.invite.issue.bulk"),
    );
  },
};

/** Every non-NULL claim code already taken in `weddingId` — the de-dupe set. */
function takenCodes(db: Db, weddingId: string): Effect.Effect<Set<string>, never, never> {
  return Effect.gen(function* () {
    const existing = yield* dbQuery(() =>
      db
        .select({ publicId: families.publicId })
        .from(families)
        .where(eq(families.weddingId, weddingId))
        .all(),
    );
    const used = new Set<string>();
    for (const r of existing) if (r.publicId !== null) used.add(r.publicId);
    return used;
  });
}
