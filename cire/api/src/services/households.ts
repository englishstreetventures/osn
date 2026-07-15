/**
 * Create a household (a `families` row) directly, with NO claim code (platform
 * Phase 0 PR 4 — "Households ≠ claim codes").
 *
 * Since migration 0032 `families.public_id` is nullable, so a manually-created
 * household starts CODE-LESS: it holds guests + can be edited, but has no
 * claimable invite until an organiser "issues" one (`issueInviteService`). This
 * is the moment a guest-list record acquires an invite credential — deliberately
 * decoupled from the household's existence.
 *
 * Contrast the CSV import (`services/import.ts`), which KEEPS auto-minting a code
 * for every imported family (the sheet IS the invite list — decision preserved):
 * only hand-created households start code-less.
 *
 * Gated one layer up by `weddingEditor()` (owner or `editor` co-host — a
 * code-less household is guest-list data, a module write, not code management);
 * this service only ever writes rows scoped to the caller-verified `weddingId`.
 */

import { families, weddings as weddingsTable } from "@cire/db";
import { eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { metricHouseholdCreated } from "../metrics";

/** The wedding doesn't exist (belt-and-braces — the gate already proved it). */
export class WeddingNotFound extends Data.TaggedError("WeddingNotFound") {}

export class HouseholdCreateError extends Data.TaggedError("HouseholdCreateError")<{
  reason: string;
  cause?: unknown;
}> {}

export interface CreatedHousehold {
  familyId: string;
  familyName: string;
  /** Always `null` — a manually-created household starts code-less. */
  publicId: null;
}

/** New family id — matches the codebase's `crypto.randomUUID` id convention. */
function mintFamilyId(): string {
  return crypto.randomUUID();
}

export const householdsService = {
  /**
   * Create a code-less household under `weddingId`. `kind` is always `guest`
   * (the synthetic host-preview family is provisioned separately by
   * `hostCodeService`, never through this path). Fails `WeddingNotFound` if the
   * wedding is missing.
   */
  create(
    weddingId: string,
    familyName: string,
  ): Effect.Effect<CreatedHousehold, WeddingNotFound | HouseholdCreateError, DbService> {
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

      const familyId = mintFamilyId();
      const trimmed = familyName.trim();
      const now = new Date();

      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .insert(families)
              .values({
                id: familyId,
                weddingId,
                // Code-less: NO public_id. The partial unique index exempts NULL,
                // so any number of these coexist.
                publicId: null,
                familyName: trimmed,
                kind: "guest",
                createdAt: now,
                updatedAt: now,
              })
              .run(),
          ),
        catch: (cause) => new HouseholdCreateError({ reason: "insert", cause }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("household create failed", { reason: err.reason }),
        ),
      );

      return { familyId, familyName: trimmed, publicId: null };
    }).pipe(
      Effect.tap(() => Effect.sync(() => metricHouseholdCreated("ok"))),
      Effect.tapError((e) =>
        e._tag === "HouseholdCreateError"
          ? Effect.sync(() => metricHouseholdCreated("error"))
          : Effect.void,
      ),
      Effect.withSpan("cire.household.create"),
    );
  },
};
