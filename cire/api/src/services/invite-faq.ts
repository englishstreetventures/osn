/**
 * The invite's FAQ section — questions the couple answers for their guests,
 * shown under the events once a household has entered its code.
 *
 * TENANCY: the route gate (`weddingEditor()`) proves the caller may touch
 * `weddingId`. Every write here also scopes by `wedding_id` in its WHERE
 * clause, so an editor of wedding A cannot change wedding B's entry with a
 * leaked id — a mismatched (weddingId, faqId) fails `FaqNotInWedding` without
 * touching a row.
 *
 * Question and answer are organiser-written free text on a guest page. They are
 * stored as sent (trimmed) and the guest site renders them as text, never as
 * HTML. Logs carry the wedding id only, never the text.
 */
import { weddingFaqs, weddingInviteCustomisations } from "@cire/db";
import { and, asc, eq, ne, notExists, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { commitGroupedBatches, DbService, dbQuery } from "../db";
import { metricInviteFaqWrite } from "../metrics";
import { FAQ_LIMITS, type FaqEntryBody } from "../schemas/invite-faq";

/** No FAQ entry with this id under this wedding (missing, or another wedding's). */
export class FaqNotInWedding extends Data.TaggedError("FaqNotInWedding") {}

/** The wedding already holds `FAQ_LIMITS.maxEntries` entries. */
export class FaqLimitReached extends Data.TaggedError("FaqLimitReached") {}

/** One FAQ entry as the organiser builder carries it. */
export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
}

/** One FAQ entry as a household receives it: the text alone. The id is what
 *  the builder edits by, and the guest page has no use for it. */
export type GuestFaqEntry = Omit<FaqEntry, "id">;

const ENTRY_FIELDS = {
  id: weddingFaqs.id,
  question: weddingFaqs.question,
  answer: weddingFaqs.answer,
};

const GUEST_ENTRY_FIELDS = {
  question: weddingFaqs.question,
  answer: weddingFaqs.answer,
};

/** The one order every read uses: the organiser's order, ties broken by id. */
const ENTRY_ORDER = [asc(weddingFaqs.sortOrder), asc(weddingFaqs.id)] as const;

/**
 * `integer({ mode: "timestamp" })` is epoch SECONDS in drizzle-sqlite. The
 * create statement binds its timestamps directly rather than through a
 * Date-valued insert, so it must use the same unit, or the rows are dated tens
 * of thousands of years ahead.
 */
const epochSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);

export const inviteFaqService = {
  /** Every entry for the wedding, in order — the organiser builder's list. */
  list(weddingId: string): Effect.Effect<FaqEntry[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      return yield* dbQuery(() =>
        db
          .select(ENTRY_FIELDS)
          .from(weddingFaqs)
          .where(eq(weddingFaqs.weddingId, weddingId))
          .orderBy(...ENTRY_ORDER)
          .all(),
      );
    }).pipe(Effect.withSpan("cire.invite.faq.list"));
  },

  /**
   * The entries a claimed household sees: the same ordered list, or none when
   * the section is switched off. The switch check is inside the one statement,
   * so a switched-off FAQ reads no entry rows at all. A wedding with no
   * customisation row reads as switched on, the column default.
   */
  listForGuests(weddingId: string): Effect.Effect<GuestFaqEntry[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      return yield* dbQuery(() =>
        db
          .select(GUEST_ENTRY_FIELDS)
          .from(weddingFaqs)
          .where(
            and(
              eq(weddingFaqs.weddingId, weddingId),
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(weddingInviteCustomisations)
                  .where(
                    and(
                      eq(weddingInviteCustomisations.weddingId, weddingId),
                      eq(weddingInviteCustomisations.faqVisible, false),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(...ENTRY_ORDER)
          .all(),
      );
    }).pipe(Effect.withSpan("cire.invite.faq.listForGuests"));
  },

  /**
   * Append an entry to the end of the list.
   *
   * ONE statement, so the cap holds under concurrent writes: the INSERT's own
   * WHERE counts the wedding's entries, and a wedding already at the cap
   * inserts nothing, which RETURNING reports as no row. The next `sort_order`
   * is computed in the same statement. A read-then-insert would let two
   * co-hosts adding at the same moment both pass the count.
   *
   * The SELECT lists its values in the table's column order, which is the
   * column list drizzle writes for an INSERT … SELECT.
   */
  create(
    weddingId: string,
    body: FaqEntryBody,
  ): Effect.Effect<FaqEntry, FaqLimitReached, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const id = `faq_${crypto.randomUUID()}`;
      const now = epochSeconds(new Date());
      const [created] = yield* dbQuery(() =>
        db
          .insert(weddingFaqs)
          .select(
            sql`SELECT ${id}, ${weddingId}, ${body.question.trim()}, ${body.answer.trim()},
              (SELECT coalesce(max(${weddingFaqs.sortOrder}), -1) + 1 FROM ${weddingFaqs}
                WHERE ${weddingFaqs.weddingId} = ${weddingId}),
              ${now}, ${now}
            WHERE (SELECT count(*) FROM ${weddingFaqs}
                WHERE ${weddingFaqs.weddingId} = ${weddingId}) < ${FAQ_LIMITS.maxEntries}`,
          )
          .returning(ENTRY_FIELDS)
          .all(),
      );
      if (!created) {
        metricInviteFaqWrite("create", "limit_reached");
        return yield* Effect.fail(new FaqLimitReached());
      }
      metricInviteFaqWrite("create", "ok");
      yield* Effect.logInfo("invite faq saved", { weddingId, action: "create" });
      return created;
    }).pipe(Effect.withSpan("cire.invite.faq.create"));
  },

  /** Replace an entry's question and answer. */
  update(
    weddingId: string,
    faqId: string,
    body: FaqEntryBody,
  ): Effect.Effect<FaqEntry, FaqNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // One round trip: RETURNING reports whether a (faq, wedding) row existed.
      const [updated] = yield* dbQuery(() =>
        db
          .update(weddingFaqs)
          .set({
            question: body.question.trim(),
            answer: body.answer.trim(),
            updatedAt: new Date(),
          })
          .where(and(eq(weddingFaqs.id, faqId), eq(weddingFaqs.weddingId, weddingId)))
          .returning(ENTRY_FIELDS)
          .all(),
      );
      if (!updated) {
        metricInviteFaqWrite("update", "not_found");
        return yield* Effect.fail(new FaqNotInWedding());
      }
      metricInviteFaqWrite("update", "ok");
      yield* Effect.logInfo("invite faq saved", { weddingId, action: "update" });
      return updated;
    }).pipe(Effect.withSpan("cire.invite.faq.update"));
  },

  /** Delete an entry. The others keep their `sort_order`; the next reorder makes it dense. */
  remove(weddingId: string, faqId: string): Effect.Effect<void, FaqNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [removed] = yield* dbQuery(() =>
        db
          .delete(weddingFaqs)
          .where(and(eq(weddingFaqs.id, faqId), eq(weddingFaqs.weddingId, weddingId)))
          .returning({ id: weddingFaqs.id })
          .all(),
      );
      if (!removed) {
        metricInviteFaqWrite("remove", "not_found");
        return yield* Effect.fail(new FaqNotInWedding());
      }
      metricInviteFaqWrite("remove", "ok");
      yield* Effect.logInfo("invite faq saved", { weddingId, action: "remove" });
    }).pipe(Effect.withSpan("cire.invite.faq.remove"));
  },

  /**
   * Store a new order: each id gets its index as `sort_order`. Scoped to the
   * wedding, so a foreign id is a no-op UPDATE rather than a write, and only a
   * row whose position changes is written — `sort_order` is in the list index,
   * so an unchanged row rewritten would cost an index write too, and a move of
   * one place would otherwise rewrite the whole list.
   * `commitGroupedBatches`, not a transaction: D1's only atomic primitive is
   * `batch()`, and each UPDATE is independent, so a re-sent order converges.
   */
  reorder(weddingId: string, orderedIds: readonly string[]): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* dbQuery(() =>
        commitGroupedBatches(
          db,
          orderedIds.map((id, index) => [
            db
              .update(weddingFaqs)
              .set({ sortOrder: index })
              .where(
                and(
                  eq(weddingFaqs.id, id),
                  eq(weddingFaqs.weddingId, weddingId),
                  ne(weddingFaqs.sortOrder, index),
                ),
              ),
          ]),
        ),
      );
      metricInviteFaqWrite("reorder", "ok");
      yield* Effect.logInfo("invite faq saved", { weddingId, action: "reorder" });
    }).pipe(Effect.withSpan("cire.invite.faq.reorder"));
  },
};
