import { weddings } from "@cire/db";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";

export type WeddingSummary = {
  id: string;
  slug: string;
  displayName: string;
};

export const weddingsService = {
  /** All weddings owned by the given OSN profile, oldest first. */
  listForOwner(osnProfileId: string): Effect.Effect<WeddingSummary[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({
            id: weddings.id,
            slug: weddings.slug,
            displayName: weddings.displayName,
          })
          .from(weddings)
          .where(eq(weddings.ownerOsnProfileId, osnProfileId))
          .orderBy(asc(weddings.createdAt))
          .all(),
      );
      return rows;
    }).pipe(Effect.withSpan("cire.wedding.listForOwner"));
  },
};
