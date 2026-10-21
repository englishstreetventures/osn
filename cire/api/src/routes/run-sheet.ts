import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingRunSheet } from "../middleware/wedding-run-sheet";
import { weddingTier } from "../middleware/wedding-tier";
import { runCire } from "../observability";
import type { OsnProfileDisplayResolver } from "../services/osn-bridge";
import { runSheetService } from "../services/run-sheet";

/** A person on the run sheet: their seat, and their name and photo when OSN
 *  resolved them. No role: a helper is not told who on the wedding is what.
 *  No OSN profile id either: the seat id is what a task's holders name, and a
 *  profile id is the same in every OSN app, so a reader has no use for it. */
interface RunSheetPersonDto {
  hostId: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
}

/**
 * The day-of run sheet — READ ONLY, for every role a wedding has:
 *
 *   GET /api/organiser/weddings/:weddingId/run-sheet
 *
 * Gated by `weddingRunSheet()`, not `weddingMember()`: the run sheet is the one
 * surface a helper may read, and the member gate refuses them. Then the Gold
 * tier (402 `payment_required` below it, for every role, a helper included),
 * then a per-organiser limiter (429): each read can look up the names of the
 * people on it over ARC, and a publish sends every open tab to read again.
 *
 * Answers `{ scope, viewerHostId, items, people }`, narrowed by
 * `runSheetService.read` to what `scope` entitles the reader to. Names are
 * looked up only for the people in the answer, and never fail the read: an
 * unreachable lookup leaves each person their seat id alone. Pass a cached
 * resolver (`cacheProfileDisplayResolver`): every open run sheet reads again
 * on each publish, and a task change changes no name. The answer itself is
 * never cached.
 */
export const createRunSheetRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
  resolveOsnProfileDisplays?: OsnProfileDisplayResolver,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingRunSheet(db))
        .use(weddingTier(db, "gold"))
        .use(rateLimitMiddlewareByUser(limiter))
        .get("/run-sheet", ({ weddingId, weddingHostId, weddingRunSheetScope, set }) => {
          set.headers["cache-control"] = "no-store";
          if (!weddingId || !weddingHostId || !weddingRunSheetScope) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            runSheetService
              .read({ weddingId, scope: weddingRunSheetScope, viewerHostId: weddingHostId })
              .pipe(
                Effect.flatMap((sheet) =>
                  Effect.gen(function* () {
                    const ids = [...new Set(sheet.people.map((p) => p.osnProfileId))];
                    const displays =
                      resolveOsnProfileDisplays && ids.length > 0
                        ? yield* Effect.tryPromise(() => resolveOsnProfileDisplays(ids)).pipe(
                            Effect.catch(() =>
                              Effect.logWarning("run sheet names unresolved").pipe(
                                Effect.annotateLogs({ weddingId }),
                                Effect.as(null),
                              ),
                            ),
                          )
                        : null;
                    const people = sheet.people.map((seat) => {
                      const person: RunSheetPersonDto = { hostId: seat.hostId };
                      const display = displays?.get(seat.osnProfileId);
                      if (display) person.handle = display.handle;
                      if (display?.displayName) person.displayName = display.displayName;
                      if (display?.avatarUrl) person.avatarUrl = display.avatarUrl;
                      return person;
                    });
                    return { ...sheet, people };
                  }),
                ),
                Effect.provideService(DbService, db),
                Effect.catchDefect(() =>
                  Effect.sync(() => {
                    set.status = 500;
                    return { error: "Internal error" };
                  }),
                ),
              ),
          );
        }),
    );
